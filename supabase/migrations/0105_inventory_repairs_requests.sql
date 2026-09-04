-- ===========================================================================
-- 0105 — inventory, part 5: repairs, requests, and a ledger that holds
-- ===========================================================================
--
-- Two new workflows and one correction to 0102.
--
-- THE CORRECTION FIRST, because it is the one that matters.
--
-- 0102 gave inv_movements.item_id `on delete cascade` and 0102's manager
-- policy grants DELETE. Together those mean a manager deleting one item
-- silently deletes its entire movement history — which makes the "insert-only
-- ledger, no update policy, nobody edits the record" posture decorative. You
-- cannot change a movement, but you can erase the item and take every movement
-- with it, and nothing is left to show it happened.
--
-- It becomes `on delete restrict`. An item that has ever moved cannot be
-- deleted by anyone; it is retired instead (retired_at), which keeps the
-- serial, the photos and the history. An item with no movements — a miscount
-- caught minutes later — still deletes cleanly, which is the case the teacher
-- delete permission in 0103/0104 exists for.
--
-- The inventory app reached the same conclusion the expensive way: its
-- delete_item() refused the moment an item had any movement, repair or
-- allocation, and archiving was the answer for anything with history. This
-- puts that rule in the schema instead of in a function, so it holds for
-- every path including ones nobody has written yet.
-- ===========================================================================

alter table public.inv_movements
  drop constraint inv_movements_item_id_fkey,
  add  constraint inv_movements_item_id_fkey
       foreign key (item_id) references public.inv_items (id) on delete restrict;

comment on constraint inv_movements_item_id_fkey on public.inv_movements is
  'restrict, not cascade: an instrument that has ever moved is retired, never '
  'deleted. Cascade would let one delete erase the ledger the delete should '
  'have been recorded in.';

-- ---------------------------------------------------------------------------
-- Types for the two workflows.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.repair_state as enum
    ('Reported', 'Pending Shipment', 'In Repair', 'Repaired',
     'Unrepairable', 'Scrapped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.request_state as enum
    ('New', 'Approved', 'Partially Fulfilled', 'Fulfilled', 'Declined');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Repairs.
--
-- One row per trip to the bench. An instrument that breaks twice has two rows,
-- because "reopening" a closed repair would lose when the first one ended.
--
-- The three closing states are terminal on purpose: Repaired means it came
-- back, Unrepairable and Scrapped mean it did not and the item is retired.
-- ---------------------------------------------------------------------------

create table public.inv_repairs (
  id               uuid primary key default gen_random_uuid(),
  item_id          uuid not null references public.inv_items (id) on delete restrict,
  repair_reason_id uuid references public.inv_repair_reasons (id) on delete set null,
  status           public.repair_state not null default 'Reported',
  image_url        text,
  notes            text,
  date_reported    date not null default current_date,
  date_returned    date,
  reported_by      uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index inv_repairs_item_idx   on public.inv_repairs (item_id);
create index inv_repairs_status_idx on public.inv_repairs (status);

-- "Is this instrument in the shop right now?" asked as one function, so the
-- list of open states exists once. The inventory app had this list written out
-- in six places and they had drifted.
create or replace function public.inv_repair_is_open(p_status public.repair_state)
returns boolean
language sql
immutable
as $$
  select p_status in ('Reported', 'Pending Shipment', 'In Repair');
$$;

-- At most one open repair per instrument. A second one would make "what is
-- wrong with this violin" a question with two answers, and every screen that
-- reads a single open repair would quietly pick one.
--
-- TRAP FOR WHOEVER ADDS A REPAIR STATE LATER: this index's predicate calls the
-- function above, and a partial index is only consulted for rows matching its
-- predicate as it was when the index was built. `create or replace`-ing
-- inv_repair_is_open() to include a new state does NOT rebuild the index — it
-- silently stops covering rows in that state, and two open repairs per item
-- become possible with no error anywhere. The order is always: drop the index,
-- replace the function, create the index again.
create unique index inv_repairs_one_open_per_item
  on public.inv_repairs (item_id)
  where public.inv_repair_is_open(status);

-- ---------------------------------------------------------------------------
-- Requests.
--
-- A school asks for instruments. The header carries who asked and for where;
-- the lines carry what, because one request is usually "two violins and a
-- stand" rather than three separate conversations.
--
-- approved_quantity is null until decided, 0 means declined, and less than
-- quantity means partly granted — fulfilment is measured against it, not
-- against what was asked for.
-- ---------------------------------------------------------------------------

create table public.inv_requests (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.inv_locations (id) on delete restrict,
  urgency_id  uuid references public.inv_urgency_levels (id) on delete set null,
  needed_by   date,
  reason      text,
  status      public.request_state not null default 'New',
  created_by  uuid references public.profiles (id) on delete set null,
  decided_by  uuid references public.profiles (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index inv_requests_location_idx on public.inv_requests (location_id);
create index inv_requests_status_idx   on public.inv_requests (status);

create table public.inv_request_lines (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references public.inv_requests (id) on delete cascade,
  -- Copied from the item type by the server, never sent by the client, so the
  -- two cannot drift.
  kind              public.item_kind not null,
  item_type_id      uuid not null references public.inv_item_types (id) on delete restrict,
  quantity          integer not null check (quantity > 0 and quantity <= 500),
  approved_quantity integer check (approved_quantity >= 0),
  status            public.request_state not null default 'New',
  note              text,
  -- set null like every other author column here: a decision outlives the
  -- person who made it. The inventory app got this wrong on exactly this
  -- column and had to fix it in a later migration.
  decided_by        uuid references public.profiles (id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint inv_request_lines_approved_within_requested check (
    approved_quantity is null or approved_quantity <= quantity
  ),
  -- One line per type. Two lines asking for violins is a single line asking
  -- for more violins.
  constraint inv_request_lines_one_per_type unique (request_id, item_type_id)
);

create index inv_request_lines_request_idx on public.inv_request_lines (request_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger t_inv_repairs_updated       before update on public.inv_repairs
  for each row execute function public.touch_updated_at();
create trigger t_inv_requests_updated      before update on public.inv_requests
  for each row execute function public.touch_updated_at();
create trigger t_inv_request_lines_updated before update on public.inv_request_lines
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
--
-- Repairs are where repair_coordinator finally gets something. It reads every
-- repair and may update one — that is the whole job. It cannot create repairs
-- (a manager decides an instrument goes to the bench) and cannot delete them.
--
-- Requests are the teacher's actual voice in this app: they file for their own
-- schools and read what they filed. Deciding is a manager's.
-- ---------------------------------------------------------------------------

alter table public.inv_repairs       enable row level security;
alter table public.inv_requests      enable row level security;
alter table public.inv_request_lines enable row level security;

create policy inv_repairs_select on public.inv_repairs
  for select to authenticated
  using (
    public.inventory_manager()
    or public.current_app_role() = 'repair_coordinator'
    or exists (select 1 from public.inv_items i where i.id = item_id)
  );

create policy inv_repairs_manage on public.inv_repairs
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

-- The one write the repairer has. Deliberately UPDATE only, and deliberately
-- not INSERT: sending an instrument to the bench is a decision about where it
-- physically goes, which belongs with whoever moves it.
create policy inv_repairs_repairer_update on public.inv_repairs
  for update to authenticated
  using (public.current_app_role() = 'repair_coordinator')
  with check (public.current_app_role() = 'repair_coordinator');

create policy inv_requests_select on public.inv_requests
  for select to authenticated
  using (
    public.inventory_manager()
    or created_by = (select auth.uid())
    or exists (select 1 from public.inv_locations l where l.id = location_id)
  );

create policy inv_requests_manage on public.inv_requests
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

-- A teacher files for a school they teach at, as themselves, and it starts as
-- New — they cannot file something pre-approved.
create policy inv_requests_teacher_insert on public.inv_requests
  for insert to authenticated
  with check (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and status = 'New'
    and decided_by is null
    and exists (
      select 1 from public.inv_locations l
       where l.id = location_id
         and l.location_type = 'School'
         and public.teacher_has_scheduled_school(l.school_id)
    )
  );

-- And may withdraw or correct it while nobody has answered. Once a manager
-- has decided, it is a record of a decision and stops being theirs to edit.
create policy inv_requests_teacher_update on public.inv_requests
  for update to authenticated
  using (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and status = 'New'
  )
  with check (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and status = 'New'
    and decided_by is null
  );

create policy inv_requests_teacher_delete on public.inv_requests
  for delete to authenticated
  using (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and status = 'New'
  );

-- Lines ride on their request: if you can see or change the request, you can
-- see or change its lines. One definition of who reaches a request, not two.
create policy inv_request_lines_select on public.inv_request_lines
  for select to authenticated
  using (exists (select 1 from public.inv_requests r where r.id = request_id));

create policy inv_request_lines_manage on public.inv_request_lines
  for all to authenticated
  using (public.inventory_manager()) with check (public.inventory_manager());

create policy inv_request_lines_teacher_write on public.inv_request_lines
  for all to authenticated
  using (
    public.current_app_role() = 'teacher'
    and exists (
      select 1 from public.inv_requests r
       where r.id = request_id
         and r.created_by = (select auth.uid())
         and r.status = 'New'
    )
  )
  with check (
    public.current_app_role() = 'teacher'
    and decided_by is null
    and exists (
      select 1 from public.inv_requests r
       where r.id = request_id
         and r.created_by = (select auth.uid())
         and r.status = 'New'
    )
  );
