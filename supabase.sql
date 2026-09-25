-- Run this once in the Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.waitlist_submissions (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(first_name) between 1 and 60),
  last_name text not null check (char_length(last_name) between 1 and 60),
  email text not null check (char_length(email) <= 254),
  phone text not null check (char_length(phone) between 7 and 30),
  state char(2) not null,
  preferred_contact_method text not null check (preferred_contact_method in ('email', 'phone', 'text')),
  support_request text check (char_length(support_request) <= 2000),
  consent boolean not null check (consent = true),
  idempotency_key text not null unique,
  request_hash text not null,
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  notification_updated_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.waitlist_submissions enable row level security;
revoke all on public.waitlist_submissions from anon, authenticated;

create index if not exists waitlist_email_created_idx
  on public.waitlist_submissions (lower(email), created_at desc);
create index if not exists waitlist_hash_created_idx
  on public.waitlist_submissions (request_hash, created_at desc);

create or replace function public.submit_waitlist(
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text,
  p_state text,
  p_contact_method text,
  p_support_request text,
  p_consent boolean,
  p_idempotency_key text,
  p_request_hash text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if not p_consent then raise exception 'CONSENT_REQUIRED'; end if;
  if p_contact_method not in ('email', 'phone', 'text') then raise exception 'INVALID_CONTACT_METHOD'; end if;
  if exists (
    select 1 from waitlist_submissions
    where lower(email) = lower(trim(p_email)) and created_at > now() - interval '24 hours'
  ) then raise exception 'WAITLIST_DUPLICATE'; end if;
  if (select count(*) from waitlist_submissions where request_hash = p_request_hash and created_at > now() - interval '15 minutes') >= 3
  then raise exception 'WAITLIST_RATE_LIMIT'; end if;

  insert into waitlist_submissions (
    first_name, last_name, email, phone, state, preferred_contact_method,
    support_request, consent, idempotency_key, request_hash
  ) values (
    trim(p_first_name), trim(p_last_name), lower(trim(p_email)), trim(p_phone), upper(trim(p_state)),
    lower(trim(p_contact_method)), nullif(trim(p_support_request), ''), p_consent, p_idempotency_key, p_request_hash
  ) returning id into new_id;
  return new_id;
exception when unique_violation then
  raise exception 'WAITLIST_DUPLICATE';
end;
$$;

revoke all on function public.submit_waitlist(text,text,text,text,text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.submit_waitlist(text,text,text,text,text,text,text,boolean,text,text) to service_role;
