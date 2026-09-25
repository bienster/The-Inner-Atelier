# The Inner Atelier

A responsive, editorial website for a private psychiatry and therapy practice, with a dedicated secure waitlist flow.

## Run locally

Node 20+ is required. No third-party runtime packages are needed.

```bash
node server.js
```

Then open `http://localhost:3000`.

## Connect the waitlist

1. Create a Supabase project and run `supabase.sql` in its SQL Editor.
2. Create a Resend account, verify the sending domain, and choose the practice notification address.
3. Copy `.env.example` to `.env` and fill in the values. Node does not load `.env` automatically; use your hosting provider’s environment settings, or start locally with those variables set in your shell.
4. Never expose `SUPABASE_SERVICE_ROLE_KEY` in browser code or commit `.env`.

The API performs independent server-side validation, writes through a locked-down Supabase function, sends the practice notification through Resend, hashes visitor IPs, and applies both in-memory and database-backed rate limits. Idempotency keys plus a 24-hour email check protect against duplicate submissions. A hidden honeypot and minimum completion time provide lightweight bot filtering.

## Before launch

- Replace placeholder practice contact information and confirm the states where care is offered.
- Add final Privacy Policy, Terms, fees, clinician credentials, licensure, and accessibility contact details.
- Configure TLS/HTTPS at the host and set a long random `RATE_LIMIT_SALT`.
- Review HIPAA/privacy requirements with counsel. If the form will collect protected health information, confirm appropriate BAAs and compliant configurations with every vendor (including hosting, Supabase, and email). The current copy intentionally asks visitors not to submit highly sensitive medical information.
- Test one real form submission in production and verify both the Supabase record and notification email.

## Image asset

`public/assets/atelier-still-life.png` was generated specifically for the revised visual direction with OpenAI image generation. Prompt direction: a premium warm-ivory editorial still life with a handmade ceramic vase, airy white flowers, blush candle, linen books, journal, brass pen, and soft botanical shadows; no people, readable text, logos, or clinical equipment.

The earlier `public/assets/inner-atelier-hero.png` remains available but is no longer used by the current design.
