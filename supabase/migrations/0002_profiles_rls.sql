-- Phase 1: profiles table, signup trigger, RLS, and role-promotion RPC.
--
-- Role model (PRD §1):
--   teacher            — default for every signup; sees only their own row
--   regional_manager   — sees rows in their region
--   operations_manager — sees all rows; promotes teachers to RM
--   cpo                — sees all rows; additionally promotes to OM; seeded
--                        manually (see 0003_seed_cpo.sql), never via signup

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  phone text,
  role public.app_role not null default 'teacher',
  -- Only meaningful for regional managers in Phase 1. Teachers' region
  -- association will come via schools (Phase 2), but managers may also set a
  -- teacher's home region here to scope RM visibility.
  region public.region,
  subjects text[] not null default '{}',
  emergency_contact text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'App profile per auth user. Created by trigger on auth.users; role changes only via promote_user() or manual seed.';

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Signup: every new auth user gets a teacher profile. Role is forced to
-- 'teacher' here regardless of client-supplied metadata, so privileged roles
-- can never be created through the signup form.
-- ---------------------------------------------------------------------------

-- Mirror the role into the JWT (app_metadata) so the Next.js proxy can do
-- optimistic route guards without a DB query. app_metadata is not writable by
-- clients. The DAL's profiles lookup stays authoritative.
create or replace function public.stamp_default_app_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.raw_app_meta_data :=
    coalesce(new.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('app_role', 'teacher');
  return new;
end;
$$;

create trigger on_auth_user_created_stamp_role
  before insert on auth.users
  for each row execute function public.stamp_default_app_role();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Unnamed'),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS helpers. SECURITY DEFINER so policy evaluation reads profiles as the
-- table owner (bypassing RLS) instead of recursing into the policies.
-- ---------------------------------------------------------------------------

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_app_region()
returns public.region
language sql
stable
security definer
set search_path = ''
as $$
  select region from public.profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Row security. Note: RLS is enabled but not FORCEd — the definer helpers
-- above must bypass it, and service_role bypasses via its role attribute.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;
grant select, update on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and region is not null
      and region = public.current_app_region()
    )
  );

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.current_app_role() in ('operations_manager', 'cpo'))
  with check (public.current_app_role() in ('operations_manager', 'cpo'));

-- RLS can't restrict individual columns, so a trigger keeps non-managers from
-- editing their own role/region/archived status through the update-own policy.
-- current_app_role() is null for service_role/owner sessions (no JWT), which
-- the null-safe IF below intentionally lets through.
create or replace function public.protect_privileged_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.role is distinct from old.role
    or new.region is distinct from old.region
    or new.archived_at is distinct from old.archived_at
  )
  and auth.uid() is not null
  and coalesce(
    public.current_app_role() in ('operations_manager', 'cpo'),
    false
  ) is false
  then
    raise exception 'changing role, region, or archived status requires an operations manager or the CPO';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_privileged_columns
  before update on public.profiles
  for each row execute function public.protect_privileged_profile_columns();

-- ---------------------------------------------------------------------------
-- Role promotion. Called from the manager UI; enforces the promotion matrix:
--   OM  → may set teacher | regional_manager
--   CPO → may set teacher | regional_manager | operations_manager
--   cpo is never assignable here (manual seed only, 0003_seed_cpo.sql)
-- ---------------------------------------------------------------------------

create or replace function public.promote_user(
  target_id uuid,
  new_role public.app_role,
  new_region public.region default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role public.app_role := public.current_app_role();
begin
  if caller_role is distinct from 'operations_manager'
     and caller_role is distinct from 'cpo' then
    raise exception 'only an operations manager or the CPO can change roles';
  end if;

  if new_role = 'cpo' then
    raise exception 'the CPO role can only be assigned manually (see 0003_seed_cpo.sql)';
  end if;

  if new_role = 'operations_manager' and caller_role <> 'cpo' then
    raise exception 'only the CPO can promote to operations manager';
  end if;

  if new_role = 'regional_manager' and new_region is null then
    raise exception 'a region is required when promoting to regional manager';
  end if;

  update public.profiles
  set role = new_role,
      -- Region travels with the RM role; other roles are region-less in Phase 1.
      region = case when new_role = 'regional_manager' then new_region else null end
  where id = target_id;

  if not found then
    raise exception 'no profile found for user %', target_id;
  end if;

  update auth.users
  set raw_app_meta_data =
    coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('app_role', new_role)
  where id = target_id;
end;
$$;

revoke execute on function public.promote_user(uuid, public.app_role, public.region)
  from public, anon;
grant execute on function public.promote_user(uuid, public.app_role, public.region)
  to authenticated;
