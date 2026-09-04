-- ===========================================================================
-- 0101 — inventory, part 1: types, vocabularies and places
-- ===========================================================================
--
-- The inventory app is moving onto this project so the organisation has one
-- account per person. This is the first of two migrations that bring its
-- schema over. Nothing here touches an existing object: every type, table,
-- policy and grant below is new. If this migration were reverted, YMU-A would
-- be byte-identical to what it is now.
--
-- WHAT CHANGES FROM THE INVENTORY'S OWN SCHEMA, AND WHY
--
--   profiles   — dropped. Its people are this project's people now. Every
--                author column below points at public.profiles.
--   regions    — dropped. It was a table of three rows; this project has a
--                region enum of five, which is a superset. locations.region
--                is that enum.
--   schools    — the inventory kept its own copy of every school inside
--                `locations`. locations.school_id now points at the real
--                school instead, so a School-type location is a reference and
--                not a duplicate. Storage and repair shops stay local rows:
--                this project does not model them and should not start.
--   'Student'  — removed from location_kind. A student is not a place. Who is
--                holding an instrument becomes a text column on the item in
--                0102, which is also queryable, unlike the old convention of
--                writing "Student: <name>" into a movement's notes.
--
-- WHO CAN DO WHAT
--   Managers — CPO, Operations, Academic, Administrator and Regional Managers
--   — read and write everything. Regional Managers are deliberately NOT
--   region-scoped here (YMU 2026-09-04): instruments move between regions and
--   a manager who cannot see where one went cannot chase it. That is a rule
--   about these new tables only; nothing about how this project scopes an RM
--   anywhere else changes.
--
--   Teachers read the places they teach at, through this project's own
--   teacher_has_scheduled_school(). Reusing it rather than inventing a second
--   answer to "which schools are yours" is the point of the merge.
--
--   repair_coordinator gets nothing here. It gets the repair pipeline in 0102.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Types. None of these names exist in this project — checked against all of
-- its types before writing. `create type` has no `if not exists`, hence the
-- guards, so a re-run is a no-op rather than an error.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.owner_type as enum ('YMU', 'MDCPS', 'Other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_kind as enum ('asset', 'part', 'accessory');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_status as enum ('Active', 'Inactive');
exception when duplicate_object then null; end $$;

-- Assets only; parts and accessories carry null. 'Damaged' and 'Broken' both
-- mean unserviceable — the difference is whether it is worth repairing.
do $$ begin
  create type public.condition_type as enum
    ('Excellent', 'Fair', 'Damaged', 'Broken', 'Missing');
exception when duplicate_object then null; end $$;

-- 'Student' is deliberately absent — see the header.
do $$ begin
  create type public.location_kind as enum
    ('School', 'Storage', 'Repair Shop', 'Other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.batch_status as enum ('Draft', 'Processed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- One helper, so every inventory policy asks the question the same way.
--
-- Deliberately not current_sees_all_regions(): that answers "sees every region
-- for the attendance app", and regional_manager is correctly absent from it.
-- Here it must be present. Two different questions, two functions — the
-- alternative is a role list copied into thirty policies, which is exactly the
-- drift migration 0072 was written to undo.
-- ---------------------------------------------------------------------------

create or replace function public.inventory_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_app_role() in (
    'cpo', 'operations_manager', 'academic_manager', 'administrator',
    'regional_manager'
  );
$$;

revoke execute on function public.inventory_manager() from public, anon;
grant execute on function public.inventory_manager() to authenticated;

comment on function public.inventory_manager() is
  'Full read/write on the inventory tables. Includes regional_manager without '
  'a region check, on purpose (YMU 2026-09-04) — instruments cross regions. '
  'Scoped to the inventory only; says nothing about the attendance app.';

-- ---------------------------------------------------------------------------
-- Vocabularies. Four small lists the app lets a manager maintain.
--
-- `active` on every one of them: these are never hard-deleted, because a row
-- is referenced by history that must keep rendering. Deactivating hides it
-- from the pickers and leaves the past intact.
-- ---------------------------------------------------------------------------

create table public.inv_categories (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inv_relocation_types (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inv_repair_reasons (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inv_urgency_levels (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  rank   integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Places.
--
-- A School row is a pointer at public.schools; a Storage or Repair Shop row
-- stands on its own. The check enforces that pairing in both directions, so
-- nobody can create a second copy of a school here, and a warehouse cannot
-- accidentally claim to be one.
--
-- `region` is denormalised rather than read through the school on purpose:
-- storage and repair shops have a region too and have no school to read it
-- from.
-- ---------------------------------------------------------------------------

create table public.inv_locations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  location_type public.location_kind not null default 'School',
  school_id     uuid references public.schools (id) on delete restrict,
  region        public.region,
  address       text,
  zip           text,
  latitude      double precision,
  longitude     double precision,
  active        boolean not null default true,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint inv_locations_school_link check (
    (location_type = 'School' and school_id is not null)
    or (location_type <> 'School' and school_id is null)
  ),
  -- One inventory row per school. Without this the duplication this migration
  -- exists to remove could be reintroduced one row at a time.
  constraint inv_locations_school_once unique (school_id)
);

create index inv_locations_type_idx   on public.inv_locations (location_type);
create index inv_locations_region_idx on public.inv_locations (region);

comment on column public.inv_locations.school_id is
  'The real school this row stands for. Required for School rows and forbidden '
  'for every other kind, so a school is referenced and never copied. '
  'on delete restrict: a school with inventory history cannot be deleted out '
  'from under it.';

-- ---------------------------------------------------------------------------
-- Item types. The serial prefix and its counter live here: a serial is
-- YMU-<abbreviation>-<sequence>, and next_sequence is owned by the server so
-- two people creating items at once cannot mint the same number.
-- ---------------------------------------------------------------------------

create table public.inv_item_types (
  id            uuid primary key default gen_random_uuid(),
  kind          public.item_kind not null,
  name          text not null,
  category_id   uuid references public.inv_categories (id) on delete restrict,
  abbreviation  text not null,
  next_sequence integer not null default 1,
  min_threshold integer,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint inv_item_types_abbr_per_kind unique (kind, abbreviation)
);

comment on column public.inv_item_types.next_sequence is
  'Server-owned. Only ever moved by the serial reservation in 0102, which '
  'increments and returns in one statement so concurrent callers cannot '
  'collide. Never set this from a client.';

-- ---------------------------------------------------------------------------
-- updated_at, using this project's existing trigger function.
-- ---------------------------------------------------------------------------

create trigger t_inv_categories_updated       before update on public.inv_categories
  for each row execute function public.touch_updated_at();
create trigger t_inv_relocation_types_updated before update on public.inv_relocation_types
  for each row execute function public.touch_updated_at();
create trigger t_inv_repair_reasons_updated   before update on public.inv_repair_reasons
  for each row execute function public.touch_updated_at();
create trigger t_inv_urgency_levels_updated   before update on public.inv_urgency_levels
  for each row execute function public.touch_updated_at();
create trigger t_inv_locations_updated        before update on public.inv_locations
  for each row execute function public.touch_updated_at();
create trigger t_inv_item_types_updated       before update on public.inv_item_types
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS.
--
-- Every policy enumerates who CAN. That is this project's existing posture and
-- it is what made adding a role in 0100 safe: a role nobody listed reaches
-- nothing. Keeping to it means the next role added is safe for the same reason.
--
-- Vocabularies are readable by anyone signed in — they are lists of words like
-- "Brass" and "To Storage", and every screen that renders an item needs them
-- to show a name instead of a uuid.
-- ---------------------------------------------------------------------------

alter table public.inv_categories       enable row level security;
alter table public.inv_relocation_types enable row level security;
alter table public.inv_repair_reasons   enable row level security;
alter table public.inv_urgency_levels   enable row level security;
alter table public.inv_locations        enable row level security;
alter table public.inv_item_types       enable row level security;

create policy inv_categories_select on public.inv_categories
  for select to authenticated using (true);
create policy inv_categories_write on public.inv_categories
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_relocation_types_select on public.inv_relocation_types
  for select to authenticated using (true);
create policy inv_relocation_types_write on public.inv_relocation_types
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_repair_reasons_select on public.inv_repair_reasons
  for select to authenticated using (true);
create policy inv_repair_reasons_write on public.inv_repair_reasons
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_urgency_levels_select on public.inv_urgency_levels
  for select to authenticated using (true);
create policy inv_urgency_levels_write on public.inv_urgency_levels
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_item_types_select on public.inv_item_types
  for select to authenticated using (true);
create policy inv_item_types_write on public.inv_item_types
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

-- Places are the one list here that is not universally readable. A teacher
-- sees the schools they actually teach at — the same answer schools_select
-- gives them in this project — plus storage and repair shops, which they need
-- named when they read where an instrument went.
create policy inv_locations_select on public.inv_locations
  for select to authenticated
  using (
    public.inventory_manager()
    or public.current_app_role() = 'repair_coordinator'
    or location_type <> 'School'
    -- Guarded rather than relying on the `or` above short-circuiting: SQL does
    -- not promise evaluation order, and school_id is null on every non-School
    -- row.
    or (location_type = 'School'
        and public.teacher_has_scheduled_school(school_id))
  );

create policy inv_locations_write on public.inv_locations
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

-- ---------------------------------------------------------------------------
-- No audit triggers, deliberately.
--
-- The inventory app had an audit_log table and an audit_row() trigger on most
-- of these. Both are being left behind: this project has no audit table at all,
-- and the inventory's own UI never read the one it wrote to — twelve SQL
-- references that write, and not a single screen that displays. A table nobody
-- queries is a table nobody notices has stopped being written.
--
-- What is actually consulted when someone asks "who moved this" is the
-- movements ledger, which is insert-only with no update policy — that arrives
-- in 0102 and is the real record.
-- ---------------------------------------------------------------------------
