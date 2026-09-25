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
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { ...securityHeaders(), ...extraHeaders });
  res.end(JSON.stringify(payload));
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
  return ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'PRACTICE_EMAIL', 'FROM_EMAIL']
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
      p_support_request: values.support || null,
      p_consent: values.consent,
      p_idempotency_key: values.idempotencyKey,
      p_request_hash: requestHash
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    const duplicate = raw.includes('WAITLIST_DUPLICATE');
    const limited = raw.includes('WAITLIST_RATE_LIMIT');
    const error = new Error(duplicate ? 'DUPLICATE' : limited ? 'RATE_LIMIT' : 'DATABASE');
    error.detail = raw;
    throw error;
  }
  const result = JSON.parse(raw);
  return typeof result === 'string' ? result : result?.id || result;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function sendNotification(values, submissionId) {
  const support = values.support ? escapeHtml(values.support).replace(/\n/g, '<br>') : '<em>Not provided</em>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: [process.env.PRACTICE_EMAIL],
      reply_to: values.email,
      subject: `New waitlist request — ${values.firstName} ${values.lastName}`,
      html: `<div style="font-family:Georgia,serif;color:#3f2929;line-height:1.6"><h2 style="font-weight:400">New waitlist request</h2><p><strong>Name:</strong> ${escapeHtml(values.firstName)} ${escapeHtml(values.lastName)}<br><strong>Email:</strong> ${escapeHtml(values.email)}<br><strong>Phone:</strong> ${escapeHtml(values.phone)}<br><strong>State:</strong> ${escapeHtml(values.state)}<br><strong>Preferred contact:</strong> ${escapeHtml(values.contactMethod)}</p><p><strong>Support requested:</strong><br>${support}</p><p style="color:#7c6864;font-size:13px">Submission ID: ${escapeHtml(submissionId)}</p></div>`
    })
  });
  if (!response.ok) throw new Error(`EMAIL_${response.status}`);
}

async function updateNotificationStatus(submissionId, status) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(submissionId)}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ notification_status: status, notification_updated_at: new Date().toISOString() })
  });
}

async function handleWaitlist(req, res) {
  const hash = ipHash(clientIp(req));
  const memoryLimit = allowedByMemoryLimit(hash);
  if (!memoryLimit.allowed) {
    return sendJson(res, 429, { message: 'Too many attempts. Please wait a little while and try again.' }, { 'Retry-After': String(memoryLimit.retryAfter) });
  }
  const missing = requiredEnv();
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    return sendJson(res, 503, { message: 'The waitlist is being connected. Please contact the practice directly for now.' });
  }
  try {
    const input = await readJson(req);
    const { values, errors } = validate(input);
    if (values.website) return sendJson(res, 200, { ok: true });
    if (!values.formStartedAt || Date.now() - values.formStartedAt < 2500 || Date.now() - values.formStartedAt > 24 * 60 * 60 * 1000) {
      return sendJson(res, 400, { message: 'Please review the form and try again.' });
    }
    if (Object.keys(errors).length) return sendJson(res, 422, { message: 'Please correct the highlighted fields.', errors });

    const submissionId = await saveSubmission(values, hash);
    try {
      await sendNotification(values, submissionId);
      await updateNotificationStatus(submissionId, 'sent');
    } catch (notificationError) {
      console.error('Waitlist notification failed:', notificationError.message);
      await updateNotificationStatus(submissionId, 'failed').catch(() => {});
    }
    return sendJson(res, 201, { ok: true, message: 'You’re on the waitlist.' });
  } catch (error) {
    if (error.message === 'BODY_TOO_LARGE') return sendJson(res, 413, { message: 'The form response is too large.' });
    if (error.message === 'DUPLICATE') return sendJson(res, 409, { message: 'This email has already joined the waitlist recently. We’ll be in touch.' });
    if (error.message === 'RATE_LIMIT') return sendJson(res, 429, { message: 'Too many attempts. Please wait a little while and try again.' });
    console.error('Waitlist submission failed:', error.detail || error);
    return sendJson(res, 500, { message: 'We couldn’t submit your request. Please try again, or contact the practice directly.' });
  }
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const routeMap = { '/': 'index.html', '/waitlist': 'waitlist.html', '/waitlist/': 'waitlist.html' };
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
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  sendJson(res, 405, { message: 'Method not allowed.' }, { Allow: 'GET, HEAD, POST' });
});

server.listen(PORT, () => console.log(`The Inner Atelier is available at http://localhost:${PORT}`));
