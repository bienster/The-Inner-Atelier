-- The Inner Atelier database setup and migration.
-- Run in the Supabase SQL Editor. It preserves the original waitlist data.
create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.waitlist') is null and to_regclass('public.waitlist_submissions') is not null then
    alter table public.waitlist_submissions rename to waitlist;
  end if;
end $$;

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(first_name) between 1 and 60),
  last_name text not null check (char_length(last_name) between 1 and 60),
  email text not null check (char_length(email) <= 254),
  phone text not null check (char_length(phone) between 7 and 30),
  state char(2) not null,
  preferred_contact_method text not null check (preferred_contact_method in ('email', 'phone', 'text')),
  support_description text check (char_length(support_description) <= 2000),
  consent_to_contact boolean not null check (consent_to_contact = true),
  status text not null default 'pending' check (status in ('pending', 'contacted', 'scheduled', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  idempotency_key text not null unique,
  request_hash text not null,
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  notification_updated_at timestamptz
);

-- Upgrade the earlier schema without losing existing submissions.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='waitlist' and column_name='support_request')
    and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='waitlist' and column_name='support_description') then
    alter table public.waitlist rename column support_request to support_description;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='waitlist' and column_name='consent')
    and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='waitlist' and column_name='consent_to_contact') then
    alter table public.waitlist rename column consent to consent_to_contact;
  end if;
end $$;

alter table public.waitlist add column if not exists status text not null default 'pending';
alter table public.waitlist add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'waitlist_status_check') then
    alter table public.waitlist add constraint waitlist_status_check check (status in ('pending', 'contacted', 'scheduled', 'removed'));
  end if;
end $$;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;
alter table public.admin_users enable row level security;
revoke all on public.waitlist from anon, authenticated;
revoke all on public.admin_users from anon, authenticated;

create or replace function public.is_waitlist_admin(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = check_user_id);
$$;

revoke all on function public.is_waitlist_admin(uuid) from public;
grant execute on function public.is_waitlist_admin(uuid) to authenticated;

drop policy if exists "Admins can view own access" on public.admin_users;
create policy "Admins can view own access" on public.admin_users
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Admins can view waitlist" on public.waitlist;
create policy "Admins can view waitlist" on public.waitlist
  for select to authenticated
  using (public.is_waitlist_admin());

drop policy if exists "Admins can update waitlist" on public.waitlist;
create policy "Admins can update waitlist" on public.waitlist
  for update to authenticated
  using (public.is_waitlist_admin())
  with check (public.is_waitlist_admin());

drop policy if exists "Admins can remove waitlist" on public.waitlist;
create policy "Admins can remove waitlist" on public.waitlist
  for delete to authenticated
  using (public.is_waitlist_admin());

grant select, update, delete on public.waitlist to authenticated;
grant select on public.admin_users to authenticated;

create index if not exists waitlist_email_created_idx on public.waitlist (lower(email), created_at desc);
create index if not exists waitlist_hash_created_idx on public.waitlist (request_hash, created_at desc);
create index if not exists waitlist_status_created_idx on public.waitlist (status, created_at desc);

create or replace function public.set_waitlist_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists waitlist_updated_at on public.waitlist;
create trigger waitlist_updated_at before update on public.waitlist
for each row execute function public.set_waitlist_updated_at();

create or replace function public.submit_waitlist(
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text,
  p_state text,
  p_contact_method text,
  p_support_description text,
  p_consent_to_contact boolean,
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
  if not p_consent_to_contact then raise exception 'CONSENT_REQUIRED'; end if;
  if p_contact_method not in ('email', 'phone', 'text') then raise exception 'INVALID_CONTACT_METHOD'; end if;
  if exists (
    select 1 from waitlist
    where lower(email) = lower(trim(p_email)) and created_at > now() - interval '24 hours'
  ) then raise exception 'WAITLIST_DUPLICATE'; end if;
  if (select count(*) from waitlist where request_hash = p_request_hash and created_at > now() - interval '15 minutes') >= 3
  then raise exception 'WAITLIST_RATE_LIMIT'; end if;

  insert into waitlist (
    first_name, last_name, email, phone, state, preferred_contact_method,
    support_description, consent_to_contact, status, idempotency_key, request_hash
  ) values (
    trim(p_first_name), trim(p_last_name), lower(trim(p_email)), trim(p_phone), upper(trim(p_state)),
    lower(trim(p_contact_method)), nullif(trim(p_support_description), ''), p_consent_to_contact,
    'pending', p_idempotency_key, p_request_hash
  ) returning id into new_id;
  return new_id;
exception when unique_violation then
  raise exception 'WAITLIST_DUPLICATE';
end;
$$;

revoke all on function public.submit_waitlist(text,text,text,text,text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.submit_waitlist(text,text,text,text,text,text,text,boolean,text,text) to service_role;

-- ADMIN SETUP (perform once after creating the therapist in Supabase Auth):
-- insert into public.admin_users (user_id, email)
-- select id, email from auth.users where email = 'therapist@example.com';
