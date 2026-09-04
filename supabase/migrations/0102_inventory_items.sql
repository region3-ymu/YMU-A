-- ===========================================================================
-- 0102 — inventory, part 2: the things and where they have been
-- ===========================================================================
--
-- Second half of the schema port. Like 0101, purely additive: four new tables,
-- nothing existing touched.
--
-- The two changes from the inventory's own schema that are not simple renames:
--
--   assigned_student_name — who is holding this instrument right now. The
--     inventory used to answer that by making the student a *location* and
--     writing "Student: <name>" into the movement's notes, which is neither
--     queryable nor clearable. 0101 removed 'Student' from location_kind; this
--     is where it lands instead. inv_movements.student_name keeps the name as
--     of that move, so handing an instrument between two students is a real
--     event in the history rather than an edit that erases the last one.
--
--   inv_movements is insert-only — no update or delete policy at all, for
--     anyone. It is the record of who moved what and when, and a ledger a
--     manager can quietly edit is not a record. This is also what replaces the
--     audit_log the inventory wrote to and never read (see 0101).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Batches. A delivery: "forty violins arrived at the warehouse". Processing
-- one mints the individual items and their serials.
--
-- The nine cnt_ columns are how many of each condition/status the batch is
-- planned to contain; a batch is Draft until processed. They are `not null
-- default 0` here — the inventory left them nullable and then had to read
-- null as zero in three places, including a comment explaining that a null
-- Excellent count means an older batch that minted everything as Fair. There
-- are no older batches here.
-- ---------------------------------------------------------------------------

create table public.inv_batches (
  id           uuid primary key default gen_random_uuid(),
  kind         public.item_kind not null,
  name         text,
  owner        public.owner_type not null default 'YMU',
  item_type_id uuid not null references public.inv_item_types (id) on delete restrict,
  location_id  uuid not null references public.inv_locations (id) on delete restrict,
  status       public.batch_status not null default 'Draft',

  -- assets: condition buckets
  cnt_active_excellent   integer not null default 0,
  cnt_active_fair        integer not null default 0,
  cnt_inactive_excellent integer not null default 0,
  cnt_inactive_fair      integer not null default 0,
  cnt_damaged            integer not null default 0,
  cnt_missing            integer not null default 0,
  cnt_in_repair          integer not null default 0,
  -- parts and accessories: no condition, just active/inactive
  cnt_active             integer not null default 0,
  cnt_inactive           integer not null default 0,

  serial_start text,
  serial_end   text,
  notes        text,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint inv_batches_counts_nonneg check (
    least(cnt_active_excellent, cnt_active_fair, cnt_inactive_excellent,
          cnt_inactive_fair, cnt_damaged, cnt_missing, cnt_in_repair,
          cnt_active, cnt_inactive) >= 0
  ),
  -- The cap exists so one typo cannot mint ten thousand serials.
  constraint inv_batches_within_cap check (
    cnt_active_excellent + cnt_active_fair + cnt_inactive_excellent
    + cnt_inactive_fair + cnt_damaged + cnt_missing + cnt_in_repair
    + cnt_active + cnt_inactive <= 500
  ),
  -- An asset batch uses only the condition buckets; a part or accessory batch
  -- only active/inactive. With this, the sum of all nine is the batch total
  -- regardless of kind, which removes the `case when kind = 'asset'` fork from
  -- every place that counts one.
  constraint inv_batches_buckets_match_kind check (
    case when kind = 'asset'
         then cnt_active = 0 and cnt_inactive = 0
         else cnt_active_excellent = 0 and cnt_active_fair = 0
          and cnt_inactive_excellent = 0 and cnt_inactive_fair = 0
          and cnt_damaged = 0 and cnt_missing = 0 and cnt_in_repair = 0
    end
  )
);

create index inv_batches_kind_idx     on public.inv_batches (kind);
create index inv_batches_location_idx on public.inv_batches (location_id);

-- ---------------------------------------------------------------------------
-- Items. One row per physical thing.
--
-- `serial` is ours and immutable once set: YMU-<abbreviation>-<number>, printed
-- on the label stuck to the instrument. `barcode` is whatever was already on it
-- — a manufacturer's sticker, a school's own tag — and is nullable because most
-- things do not have one.
--
-- `condition` is assets-only; parts and accessories carry null. Damaged and
-- Broken both mean unserviceable, and an item in either state cannot be Active
-- — the constraint below is that rule, not a suggestion.
-- ---------------------------------------------------------------------------

create table public.inv_items (
  id           uuid primary key default gen_random_uuid(),
  kind         public.item_kind not null,
  item_type_id uuid not null references public.inv_item_types (id) on delete restrict,
  owner        public.owner_type not null default 'YMU',
  brand        text,
  location_id  uuid references public.inv_locations (id) on delete restrict,
  condition    public.condition_type,
  status       public.item_status not null default 'Inactive',
  serial       text not null unique,
  barcode      text,
  image_url    text,
  notes        text,

  -- Who physically has it. Null means it is at a place rather than with a
  -- person. Cleared by the same statement that records the movement away, so
  -- the two can never disagree.
  assigned_student_name text,

  batch_id     uuid references public.inv_batches (id) on delete set null,
  retired_at     timestamptz,
  retired_reason text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Condition is an assets-only idea. A part with a condition is a part
  -- somebody filled in a field they should not have seen.
  constraint inv_items_condition_assets_only check (
    (kind = 'asset') or (condition is null)
  ),
  -- Unserviceable is never in use. The inventory had no such constraint and
  -- reported Active+Broken assets as "in use" on the dashboard.
  constraint inv_items_unserviceable_is_inactive check (
    not (kind = 'asset' and condition in ('Damaged', 'Broken')
         and status = 'Active')
  )
);

create index inv_items_type_idx     on public.inv_items (item_type_id);
create index inv_items_location_idx on public.inv_items (location_id);
create index inv_items_batch_idx    on public.inv_items (batch_id);
create index inv_items_barcode_idx  on public.inv_items (barcode) where barcode is not null;
create index inv_items_live_idx     on public.inv_items (kind) where retired_at is null;

comment on column public.inv_items.assigned_student_name is
  'Who is holding this right now, or null. Replaces the old convention of a '
  'Student-type location plus a "Student: <name>" prefix in movement notes, '
  'which could not be searched and was never cleared.';

-- ---------------------------------------------------------------------------
-- Photos and documents hung off an item.
-- ---------------------------------------------------------------------------

create table public.inv_attachments (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.inv_items (id) on delete cascade,
  url        text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index inv_attachments_item_idx on public.inv_attachments (item_id);

-- ---------------------------------------------------------------------------
-- Movements. The ledger.
--
-- One row per relocation, never edited. `from_location_id` is nullable because
-- an item's first movement has no origin. Author columns are `on delete set
-- null` throughout: the ledger outlives the person who wrote it, and a
-- departing staff member must not be undeletable because of a move they made
-- two years ago.
-- ---------------------------------------------------------------------------

create table public.inv_movements (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid references public.inv_items (id) on delete cascade,
  batch_id           uuid references public.inv_batches (id) on delete cascade,
  from_location_id   uuid references public.inv_locations (id) on delete restrict,
  to_location_id     uuid not null references public.inv_locations (id) on delete restrict,
  relocation_type_id uuid references public.inv_relocation_types (id) on delete set null,

  -- The holder as of this move. Kept alongside items.assigned_student_name so
  -- history stays true after the item moves on.
  student_name       text,

  moved_by  uuid references public.profiles (id) on delete set null,
  moved_at  timestamptz not null default now(),
  notes     text,
  created_at timestamptz not null default now(),

  -- Every row describes a move of an item, of a whole batch, or of both.
  constraint inv_movements_has_subject check (
    item_id is not null or batch_id is not null
  )
);

create index inv_movements_item_idx on public.inv_movements (item_id);
create index inv_movements_to_idx   on public.inv_movements (to_location_id);
create index inv_movements_from_idx on public.inv_movements (from_location_id);
create index inv_movements_when_idx on public.inv_movements (moved_at desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger t_inv_batches_updated before update on public.inv_batches
  for each row execute function public.touch_updated_at();
create trigger t_inv_items_updated   before update on public.inv_items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
--
-- Teachers read items through the places they can already see. The subquery
-- is itself filtered by inv_locations_select, so "which schools are yours" has
-- exactly one definition and this policy inherits it rather than restating it.
-- ---------------------------------------------------------------------------

alter table public.inv_batches     enable row level security;
alter table public.inv_items       enable row level security;
alter table public.inv_attachments enable row level security;
alter table public.inv_movements   enable row level security;

create policy inv_batches_select on public.inv_batches
  for select to authenticated
  using (
    public.inventory_manager()
    or exists (select 1 from public.inv_locations l where l.id = location_id)
  );
create policy inv_batches_write on public.inv_batches
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_items_select on public.inv_items
  for select to authenticated
  using (
    public.inventory_manager()
    -- The repair coordinator needs to see any instrument that might reach the
    -- bench, not only ones already in repair.
    or public.current_app_role() = 'repair_coordinator'
    or location_id is null
    or exists (select 1 from public.inv_locations l where l.id = location_id)
  );
create policy inv_items_write on public.inv_items
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_attachments_select on public.inv_attachments
  for select to authenticated
  using (exists (select 1 from public.inv_items i where i.id = item_id));
create policy inv_attachments_write on public.inv_attachments
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

-- Read-only for everyone who can see the item. NO insert, update or delete
-- policy, deliberately: the only writer is the relocation function in a later
-- migration, which is SECURITY DEFINER. A ledger the API can rewrite is not a
-- ledger.
create policy inv_movements_select on public.inv_movements
  for select to authenticated
  using (
    public.inventory_manager()
    or public.current_app_role() = 'repair_coordinator'
    or exists (select 1 from public.inv_items i where i.id = item_id)
  );
