-- Phase 2: schools, school_years, RLS, and the manager-only teacher directory.
--
-- Region rule (PRD §Phase 2): region assignment is OM/CPO only, and is
-- immutable to Regional Managers once set. Mirrors 0002's pattern for
-- profiles.role/region: RLS lets any manager write most columns, a trigger
-- blocks the region column specifically for non-OM/CPO callers. RMs may
-- still create a school with region left null (they found it, they add it;
-- someone with region authority assigns it later).

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  contact_name text,
  contact_phone text,
  lat double precision,
  lng double precision,
  -- 'census' | 'nominatim' | 'manual' — set by the geocode action / override
  -- form; not an enum since it's a UI-facing provenance label, not a domain
  -- constraint enforced anywhere else.
  geocode_source text,
  geofence_radius_m integer not null default 200,
  region public.region,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.schools is
  'A school site teachers clock in at. region is OM/CPO-only to set or change (see protect_school_region trigger below).';

create trigger schools_touch_updated_at
  before update on public.schools
  for each row execute function public.touch_updated_at();

create table public.school_years (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_date date not null,
  end_date date not null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_years_dates_order check (end_date > start_date)
);

comment on table public.school_years is
  'School-year lifecycle scaffold (Phase 2 stores it; linking schools/attendance to a year is a later phase).';

create trigger school_years_touch_updated_at
  before update on public.school_years
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- schools RLS
-- ---------------------------------------------------------------------------

alter table public.schools enable row level security;

revoke all on table public.schools from anon, authenticated;
grant select, insert, update on table public.schools to authenticated;
grant all on table public.schools to service_role;

-- OM/CPO see every school. RMs see schools in their own region plus
-- unassigned (region is null) ones, so they can find and edit new schools
-- awaiting a region call. Teachers get no access yet — the Lists tab is
-- manager-only (ROUTE_ROLES); clocking (Phase 4) will need to revisit this.
create policy schools_select on public.schools
  for select to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (region is null or region = public.current_app_region())
    )
  );

-- Any manager can add a school (name/address/geocode/contact). Only OM/CPO
-- may set a region at creation time; RMs must leave it null.
create policy schools_insert on public.schools
  for insert to authenticated
  with check (
    public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo')
    and (
      region is null
      or public.current_app_role() in ('operations_manager', 'cpo')
    )
  );

-- Any manager can update a school (contact info, lat/lng override, geofence
-- radius); the region column specifically is locked down further by the
-- trigger below, which is the actual immutability enforcement.
create policy schools_update on public.schools
  for update to authenticated
  using (public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo'))
  with check (public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo'));

-- RLS can't restrict a single column, so region changes are blocked here for
-- everyone except OM/CPO (and service-role/owner sessions, which have no JWT
-- and are intentionally let through — same null-safe pattern as profiles).
create or replace function public.protect_school_region()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.region is distinct from old.region
  and auth.uid() is not null
  and coalesce(
    public.current_app_role() in ('operations_manager', 'cpo'),
    false
  ) is false
  then
    raise exception 'only an operations manager or the CPO can assign or change a school''s region';
  end if;
  return new;
end;
$$;

create trigger schools_protect_region
  before update on public.schools
  for each row execute function public.protect_school_region();

-- ---------------------------------------------------------------------------
-- school_years RLS — read for any manager, write for OM/CPO only. Nothing
-- consumes this table functionally yet (Phase 9 wires the lifecycle); this
-- just gets the table and its access rules in place per the Phase 2 file list.
-- ---------------------------------------------------------------------------

alter table public.school_years enable row level security;

revoke all on table public.school_years from anon, authenticated;
grant select, insert, update on table public.school_years to authenticated;
grant all on table public.school_years to service_role;

create policy school_years_select on public.school_years
  for select to authenticated
  using (public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo'));

create policy school_years_write on public.school_years
  for all to authenticated
  using (public.current_app_role() in ('operations_manager', 'cpo'))
  with check (public.current_app_role() in ('operations_manager', 'cpo'));

-- ---------------------------------------------------------------------------
-- Teacher directory: profile popovers need email, which lives in auth.users,
-- not profiles (Phase 1 punted this). Security-definer RPC instead of
-- syncing email onto profiles — no duplicated, driftable copy of auth data.
-- Manually replicates the profiles_select region-scoping (RM: own region
-- only; OM/CPO: everyone) since SECURITY DEFINER bypasses RLS.
-- ---------------------------------------------------------------------------

create or replace function public.teacher_directory()
returns table (
  id uuid,
  full_name text,
  email text,
  phone text,
  region public.region
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name, u.email, p.phone, p.region
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
    and p.archived_at is null
    and (
      public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and p.region is not null
        and p.region = public.current_app_region()
      )
    );
$$;

revoke execute on function public.teacher_directory() from public, anon;
grant execute on function public.teacher_directory() to authenticated;

-- ---------------------------------------------------------------------------
-- Haversine distance, SQL twin of src/lib/geo/haversine.ts. Not used by any
-- geofence check yet (Phase 4/5) — Phase 2's own use is a "moved N meters
-- from the geocoded address" hint when a manager manually overrides lat/lng.
-- ---------------------------------------------------------------------------

create or replace function public.haversine_meters(
  lat1 double precision,
  lng1 double precision,
  lat2 double precision,
  lng2 double precision
)
returns double precision
language sql
immutable
parallel safe
as $$
  select 6371000 * acos(
    least(1, greatest(-1,
      cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lng2) - radians(lng1))
      + sin(radians(lat1)) * sin(radians(lat2))
    ))
  );
$$;
