const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 4;
const requestBuckets = new Map();
const ADMIN_COOKIE = 'inner_atelier_admin';
const ADMIN_REFRESH_COOKIE = 'inner_atelier_admin_refresh';
const WAITLIST_STATUSES = new Set(['pending', 'contacted', 'scheduled', 'removed']);

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
]);
const CONTACT_METHODS = new Set(['email', 'phone', 'text']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { ...securityHeaders(), 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function cookieHeader(name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearAdminCookies() {
  return [cookieHeader(ADMIN_COOKIE, '', 0), cookieHeader(ADMIN_REFRESH_COOKIE, '', 0)];
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = process.env.SITE_URL || `http://${req.headers.host}`;
  return origin === expected;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() || req.socket.remoteAddress || 'unknown';
}

function ipHash(ip) {
  const salt = process.env.RATE_LIMIT_SALT || 'development-only-salt';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function allowedByMemoryLimit(key) {
  const now = Date.now();
  const recent = (requestBuckets.get(key) || []).filter((time) => now - time < WINDOW_MS);
  recent.push(now);
  requestBuckets.set(key, recent);
  return { allowed: recent.length <= MAX_REQUESTS, retryAfter: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function validate(input) {
  const values = {
    firstName: clean(input.firstName, 60),
    lastName: clean(input.lastName, 60),
    email: clean(input.email, 254).toLowerCase(),
    phone: clean(input.phone, 30),
    state: clean(input.state, 2).toUpperCase(),
    contactMethod: clean(input.contactMethod, 10).toLowerCase(),
    support: typeof input.support === 'string' ? input.support.trim().slice(0, 2000) : '',
    consent: input.consent === true,
    website: clean(input.website, 200),
    formStartedAt: Number(input.formStartedAt),
    idempotencyKey: clean(input.idempotencyKey, 80)
  };
  const errors = {};
  const namePattern = /^[\p{L}\p{M}][\p{L}\p{M}'’ .-]{0,59}$/u;
  if (!namePattern.test(values.firstName)) errors.firstName = 'Enter your first name.';
  if (!namePattern.test(values.lastName)) errors.lastName = 'Enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = 'Enter a valid email address.';
  if (!/^\+?[0-9() .-]{7,24}$/.test(values.phone) || values.phone.replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number.';
  if (!US_STATES.has(values.state)) errors.state = 'Select your state.';
  if (!CONTACT_METHODS.has(values.contactMethod)) errors.contactMethod = 'Choose a contact method.';
  if (!values.consent) errors.consent = 'Consent is required to join the waitlist.';
  if (!/^[a-f0-9-]{24,80}$/i.test(values.idempotencyKey)) errors.form = 'Please refresh the page and try again.';
  return { values, errors };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  }
  return JSON.parse(body || '{}');
}

function requiredEnv() {
  return ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RATE_LIMIT_SALT']
    .filter((key) => !process.env[key]);
}

async function saveSubmission(values, requestHash) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/submit_waitlist`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_first_name: values.firstName,
      p_last_name: values.lastName,
      p_email: values.email,
      p_phone: values.phone,
      p_state: values.state,
      p_contact_method: values.contactMethod,
      p_support_description: values.support || null,
      p_consent_to_contact: values.consent,
      p_idempotency_key: values.idempotencyKey,
      p_request_hash: requestHash
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    const duplicate = raw.includes('WAITLIST_DUPLICATE');
    const limited = raw.includes('WAITLIST_RATE_LIMIT');
    const error = new Error(duplicate ? 'DUPLICATE' : limited ? 'RATE_LIMIT' : 'DATABASE');
    throw error;
  }
  const result = JSON.parse(raw);
  return typeof result === 'string' ? result : result?.id || result;
}

async function handleWaitlist(req, res) {
  const missing = requiredEnv();
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    return sendJson(res, 503, { message: 'The waitlist is being connected. Please contact the practice directly for now.' });
  }
  const hash = ipHash(clientIp(req));
  const memoryLimit = allowedByMemoryLimit(hash);
  if (!memoryLimit.allowed) {
    return sendJson(res, 429, { message: 'Too many attempts. Please wait a little while and try again.' }, { 'Retry-After': String(memoryLimit.retryAfter) });
  }
  try {
    const input = await readJson(req);
    const { values, errors } = validate(input);
    if (values.website) return sendJson(res, 200, { ok: true });
    if (!values.formStartedAt || Date.now() - values.formStartedAt < 2500 || Date.now() - values.formStartedAt > 24 * 60 * 60 * 1000) {
      return sendJson(res, 400, { message: 'Please review the form and try again.' });
    }
    if (Object.keys(errors).length) return sendJson(res, 422, { message: 'Please correct the highlighted fields.', errors });

    await saveSubmission(values, hash);
    return sendJson(res, 201, { ok: true, message: 'You’re on the waitlist.' });
  } catch (error) {
    if (error.message === 'BODY_TOO_LARGE') return sendJson(res, 413, { message: 'The form response is too large.' });
    if (error.message === 'DUPLICATE') return sendJson(res, 409, { message: 'This email has already joined the waitlist recently. We’ll be in touch.' });
    if (error.message === 'RATE_LIMIT') return sendJson(res, 429, { message: 'Too many attempts. Please wait a little while and try again.' });
    console.error('Waitlist submission failed:', error.message);
    return sendJson(res, 500, { message: 'We couldn’t submit your request. Please try again, or contact the practice directly.' });
  }
}

function adminEnvReady() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

async function supabaseAuth(pathname, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}/auth/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function supabaseRest(pathname, token, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function refreshAdminSession(refreshToken) {
  if (!refreshToken) return null;
  const response = await supabaseAuth('token?grant_type=refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!response.ok) return null;
  return response.json();
}

async function getAdmin(req, res) {
  if (!adminEnvReady()) return null;
  const cookies = parseCookies(req);
  let accessToken = cookies[ADMIN_COOKIE];
  let refreshToken = cookies[ADMIN_REFRESH_COOKIE];
  let userResponse = accessToken
    ? await supabaseAuth('user', { headers: { Authorization: `Bearer ${accessToken}` } })
    : null;

  if (!userResponse?.ok && refreshToken) {
    const refreshed = await refreshAdminSession(refreshToken);
    if (refreshed?.access_token) {
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token || refreshToken;
      res.setHeader('Set-Cookie', [
        cookieHeader(ADMIN_COOKIE, accessToken, Number(refreshed.expires_in || 3600)),
        cookieHeader(ADMIN_REFRESH_COOKIE, refreshToken, 60 * 60 * 24 * 30)
      ]);
      userResponse = await supabaseAuth('user', { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }
  if (!userResponse?.ok) return null;
  const user = await userResponse.json();
  const adminResponse = await supabaseRest(`admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,email`, accessToken);
  if (!adminResponse.ok) return null;
  const admins = await adminResponse.json();
  if (!admins.length) return null;
  return { user, token: accessToken };
}

async function handleAdminLogin(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { message: 'Request origin was not accepted.' });
  if (!adminEnvReady()) return sendJson(res, 503, { message: 'Admin authentication is not configured.' });
  try {
    const input = await readJson(req);
    const email = clean(input.email, 254).toLowerCase();
    const password = typeof input.password === 'string' ? input.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || password.length < 8) {
      return sendJson(res, 422, { message: 'Enter a valid email and password.' });
    }
    const response = await supabaseAuth('token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (!response.ok) return sendJson(res, 401, { message: 'Email or password was not recognized.' });
    const session = await response.json();
    const adminCheck = await supabaseRest(`admin_users?user_id=eq.${encodeURIComponent(session.user.id)}&select=user_id`, session.access_token);
    const admins = adminCheck.ok ? await adminCheck.json() : [];
    if (!admins.length) return sendJson(res, 403, { message: 'This account does not have dashboard access.' });
    return sendJson(res, 200, { ok: true, user: { email: session.user.email } }, {
      'Set-Cookie': [
        cookieHeader(ADMIN_COOKIE, session.access_token, Number(session.expires_in || 3600)),
        cookieHeader(ADMIN_REFRESH_COOKIE, session.refresh_token, 60 * 60 * 24 * 30)
      ]
    });
  } catch {
    return sendJson(res, 400, { message: 'Unable to sign in. Please try again.' });
  }
}

async function handleAdminSession(req, res) {
  const admin = await getAdmin(req, res);
  if (!admin) return sendJson(res, 401, { authenticated: false }, { 'Set-Cookie': clearAdminCookies() });
  return sendJson(res, 200, { authenticated: true, user: { email: admin.user.email } });
}

function requireAdminBody(req, res) {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { message: 'Request origin was not accepted.' });
    return false;
  }
  return true;
}

async function handleAdminQuery(req, res) {
  if (!requireAdminBody(req, res)) return;
  const admin = await getAdmin(req, res);
  if (!admin) return sendJson(res, 401, { message: 'Your session has expired. Please sign in again.' });
  try {
    const input = await readJson(req);
    const status = clean(input.status, 20).toLowerCase();
    const filter = status && WAITLIST_STATUSES.has(status) ? `&status=eq.${status}` : '';
    const fields = 'id,first_name,last_name,email,phone,state,preferred_contact_method,support_description,consent_to_contact,status,created_at,updated_at';
    const response = await supabaseRest(`waitlist?select=${fields}${filter}&order=created_at.desc&limit=500`, admin.token);
    if (!response.ok) return sendJson(res, 502, { message: 'The waitlist could not be loaded.' });
    const submissions = await response.json();
    return sendJson(res, 200, { submissions });
  } catch {
    return sendJson(res, 400, { message: 'The waitlist request was invalid.' });
  }
}

async function handleAdminUpdate(req, res) {
  if (!requireAdminBody(req, res)) return;
  const admin = await getAdmin(req, res);
  if (!admin) return sendJson(res, 401, { message: 'Your session has expired. Please sign in again.' });
  try {
    const input = await readJson(req);
    const id = clean(input.id, 50);
    const status = clean(input.status, 20).toLowerCase();
    if (!/^[a-f0-9-]{36}$/i.test(id) || !WAITLIST_STATUSES.has(status)) return sendJson(res, 422, { message: 'Invalid status update.' });
    const response = await supabaseRest(`waitlist?id=eq.${encodeURIComponent(id)}`, admin.token, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status })
    });
    if (!response.ok) return sendJson(res, 502, { message: 'The status could not be updated.' });
    const updated = await response.json();
    return sendJson(res, 200, { submission: updated[0] });
  } catch {
    return sendJson(res, 400, { message: 'The update request was invalid.' });
  }
}

async function handleAdminRemove(req, res) {
  if (!requireAdminBody(req, res)) return;
  const admin = await getAdmin(req, res);
  if (!admin) return sendJson(res, 401, { message: 'Your session has expired. Please sign in again.' });
  try {
    const input = await readJson(req);
    const id = clean(input.id, 50);
    if (!/^[a-f0-9-]{36}$/i.test(id)) return sendJson(res, 422, { message: 'Invalid submission.' });
    const response = await supabaseRest(`waitlist?id=eq.${encodeURIComponent(id)}`, admin.token, { method: 'DELETE' });
    if (!response.ok) return sendJson(res, 502, { message: 'The submission could not be removed.' });
    return sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 400, { message: 'The removal request was invalid.' });
  }
}

async function handleAdminLogout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { message: 'Request origin was not accepted.' });
  const cookies = parseCookies(req);
  if (cookies[ADMIN_COOKIE] && adminEnvReady()) {
    await supabaseAuth('logout', { method: 'POST', headers: { Authorization: `Bearer ${cookies[ADMIN_COOKIE]}` } }).catch(() => {});
  }
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearAdminCookies() });
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const routeMap = { '/': 'index.html', '/waitlist': 'waitlist.html', '/waitlist/': 'waitlist.html', '/admin': 'admin.html', '/admin/': 'admin.html' };
  const requested = routeMap[pathname] || pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, securityHeaders('text/plain; charset=utf-8'));
    return res.end('Forbidden');
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404, securityHeaders('text/html; charset=utf-8'));
      return res.end('<h1>Page not found</h1>');
    }
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === '.png' ? 'public, max-age=604800, immutable' : 'no-cache';
    res.writeHead(200, { ...securityHeaders(MIME_TYPES[ext] || 'application/octet-stream'), 'Cache-Control': cache });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/waitlist') return handleWaitlist(req, res);
  if (req.method === 'POST' && req.url === '/api/admin/login') return handleAdminLogin(req, res);
  if (req.method === 'GET' && req.url === '/api/admin/session') return handleAdminSession(req, res);
  if (req.method === 'POST' && req.url === '/api/admin/query') return handleAdminQuery(req, res);
  if (req.method === 'POST' && req.url === '/api/admin/update') return handleAdminUpdate(req, res);
  if (req.method === 'POST' && req.url === '/api/admin/remove') return handleAdminRemove(req, res);
  if (req.method === 'POST' && req.url === '/api/admin/logout') return handleAdminLogout(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  sendJson(res, 405, { message: 'Method not allowed.' }, { Allow: 'GET, HEAD, POST' });
});

server.listen(PORT, () => console.log(`The Inner Atelier is available at http://localhost:${PORT}`));
