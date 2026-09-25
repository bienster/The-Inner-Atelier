import { createClient } from 'npm:@supabase/supabase-js@2'

const MAX_BODY_BYTES = 16 * 1024
const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'])
const CONTACT_METHODS = new Set(['email', 'phone', 'text'])

function response(origin: string, status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      Vary: 'Origin'
    }
  })
}

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

function validate(input: Record<string, unknown>) {
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
  }
  const errors: Record<string, string> = {}
  const namePattern = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,59}$/u
  if (!namePattern.test(values.firstName)) errors.firstName = 'Enter your first name.'
  if (!namePattern.test(values.lastName)) errors.lastName = 'Enter your last name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = 'Enter a valid email address.'
  if (!/^\+?[0-9() .-]{7,24}$/.test(values.phone) || values.phone.replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number.'
  if (!US_STATES.has(values.state)) errors.state = 'Select your state.'
  if (!CONTACT_METHODS.has(values.contactMethod)) errors.contactMethod = 'Choose a contact method.'
  if (!values.consent) errors.consent = 'Consent is required to join the waitlist.'
  if (!/^[a-f0-9-]{24,80}$/i.test(values.idempotencyKey)) errors.form = 'Please refresh the page and try again.'
  return { values, errors }
}

async function hashIp(request: Request) {
  const rawIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const salt = Deno.env.get('RATE_LIMIT_SALT') || ''
  if (!salt) throw new Error('RATE_LIMIT_NOT_CONFIGURED')
  const bytes = new TextEncoder().encode(`${salt}:${rawIp}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || ''
  const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean)
  if (!allowedOrigins.includes(origin)) return response(origin || 'null', 403, { message: 'Request origin was not accepted.' })
  if (request.method === 'OPTIONS') return response(origin, 204)
  if (request.method !== 'POST') return response(origin, 405, { message: 'Method not allowed.' })
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return response(origin, 413, { message: 'The form response is too large.' })

  try {
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return response(origin, 413, { message: 'The form response is too large.' })
    }
    const input = JSON.parse(rawBody) as Record<string, unknown>
    const { values, errors } = validate(input)
    if (values.website) return response(origin, 200, { ok: true })
    if (!values.formStartedAt || Date.now() - values.formStartedAt < 2500 || Date.now() - values.formStartedAt > 24 * 60 * 60 * 1000) {
      return response(origin, 400, { message: 'Please review the form and try again.' })
    }
    if (Object.keys(errors).length) return response(origin, 422, { message: 'Please correct the highlighted fields.', errors })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) return response(origin, 503, { message: 'The waitlist is being connected. Please contact the practice directly for now.' })
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await supabase.rpc('submit_waitlist', {
      p_first_name: values.firstName,
      p_last_name: values.lastName,
      p_email: values.email,
      p_phone: values.phone,
      p_state: values.state,
      p_contact_method: values.contactMethod,
      p_support_description: values.support || null,
      p_consent_to_contact: values.consent,
      p_idempotency_key: values.idempotencyKey,
      p_request_hash: await hashIp(request)
    })
    if (error?.message.includes('WAITLIST_DUPLICATE')) return response(origin, 409, { message: 'This email has already joined the waitlist recently. We will be in touch.' })
    if (error?.message.includes('WAITLIST_RATE_LIMIT')) return response(origin, 429, { message: 'Too many attempts. Please wait a little while and try again.' })
    if (error) throw error
    return response(origin, 201, { ok: true, message: 'You are on the waitlist.' })
  } catch (error) {
    if (error instanceof SyntaxError) return response(origin, 400, { message: 'The form request was invalid.' })
    if (error instanceof Error && error.message === 'RATE_LIMIT_NOT_CONFIGURED') return response(origin, 503, { message: 'The waitlist is being connected. Please contact the practice directly for now.' })
    console.error('Waitlist submission failed:', error instanceof Error ? error.message : 'unknown error')
    return response(origin, 500, { message: 'We could not submit your request. Please try again, or contact the practice directly.' })
  }
})
