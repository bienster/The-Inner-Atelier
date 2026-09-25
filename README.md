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
2. Copy `.env.example` to `.env` and fill in the values, including the Supabase anon key used by the server-side authentication proxy. Node does not load `.env` automatically; use your hosting provider’s environment settings, or start locally with those variables set in your shell.
3. Never expose `SUPABASE_SERVICE_ROLE_KEY` in browser code or commit `.env`.

The API performs independent server-side validation, writes through a locked-down Supabase function, hashes visitor IPs, and applies both in-memory and database-backed rate limits. Idempotency keys plus a 24-hour email check protect against duplicate submissions. A hidden honeypot and minimum completion time provide lightweight bot filtering.

## Private practice dashboard

The dashboard is available at `http://localhost:3000/admin`. It supports:

- authenticated access through Supabase Auth;
- waitlist search and status filtering;
- request details and submission dates;
- status changes (`pending`, `contacted`, `scheduled`, `removed`); and
- permanent removal with a confirmation step.

To authorize the therapist:

1. In Supabase, create the therapist account under **Authentication → Users**. Do not enable public sign-up for the dashboard.
2. Run the following in the SQL Editor, replacing the example email:

```sql
insert into public.admin_users (user_id, email)
select id, email from auth.users
where email = 'therapist@example.com'
on conflict (user_id) do update set email = excluded.email;
```

The browser uses Supabase's publishable key, which is intentionally public and constrained by Row Level Security. The dashboard keeps an authenticated admin token only in memory, and the `admin_users` allowlist controls which authenticated users can access waitlist data.

## Before launch

- Replace placeholder practice contact information and confirm the states where care is offered.
- Add final Privacy Policy, Terms, fees, clinician credentials, licensure, and accessibility contact details.
- Configure TLS/HTTPS at the host and set a long random `RATE_LIMIT_SALT`.
- Review HIPAA/privacy requirements with counsel. Using Supabase does not by itself make this application HIPAA compliant. If the form will collect protected health information, confirm appropriate BAAs, policies, retention controls, audit practices, and compliant configurations with every vendor (including hosting, Supabase, and email). The current copy intentionally asks visitors not to submit highly sensitive medical information.
- Test one real form submission in production and verify the Supabase record.

## Deploy on Hostinger Premium

Hostinger Premium serves the public website as static files. The waitlist validation runs in the included Supabase Edge Function, and the dashboard talks directly to Supabase Auth and the existing Row Level Security policies. The visual pages and URLs remain unchanged.

1. In Supabase **Edge Functions**, create a function named `submit-waitlist`, replace its code with `supabase/functions/submit-waitlist/index.ts`, and disable JWT verification for this public form endpoint. Deploy it.
2. In Supabase **Edge Function Secrets**, set `ALLOWED_ORIGINS` to the final origin(s) (for example, `https://your-domain.com,https://www.your-domain.com`) and set a long random `RATE_LIMIT_SALT`. Never add the service-role key as a Hostinger file or browser value.
3. Copy `public/config.example.js` to `public/config.js`. Fill in the project URL and the Supabase **publishable (or legacy anon) key**. This key is safe to expose in browser code when RLS is enabled; it is not the service-role key.
4. In Hostinger File Manager, upload the **contents** of `public/` (including `.htaccess` and `config.js`) into `public_html/`. Do not upload `.env`, `server.js`, or the `supabase/` directory to Hostinger.
5. Test `/waitlist` and `/admin` over HTTPS. The admin account must exist in Supabase Auth and in `public.admin_users` as described above.

The static host never receives a service-role key. The Edge Function receives the built-in Supabase server credential at runtime, while the browser is limited by Row Level Security.

## Image asset

`public/assets/atelier-still-life.png` was generated specifically for the revised visual direction with OpenAI image generation. Prompt direction: a premium warm-ivory editorial still life with a handmade ceramic vase, airy white flowers, blush candle, linen books, journal, brass pen, and soft botanical shadows; no people, readable text, logos, or clinical equipment.

The earlier `public/assets/inner-atelier-hero.png` remains available but is no longer used by the current design.
