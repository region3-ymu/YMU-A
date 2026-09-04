-- ===========================================================================
-- 0103 — inventory, part 3: teachers count, managers verify
-- ===========================================================================
--
-- The workflow this replaces: a teacher walks their room and records what is
-- there, and a manager checks it. The inventory app modelled that with a
-- generic approval queue — 1,015 lines, seven action types, every write path
-- implemented twice so a queued edit and a direct edit could behave the same.
-- That queue is not being ported (YMU 2026-09-04).
--
-- What replaces it is two columns and four policies. A teacher's count exists
-- the moment they enter it, marked unverified; a manager confirms or corrects
-- it. That is closer to what a stock-take is for: an inventory that is
-- provisional tells you more than one that is empty because nobody has clicked
-- approve yet.
--
-- The trade this makes deliberately: a teacher's mistake reaches the database
-- instead of being caught in a queue. It is bounded — the row is flagged
-- unverified, it can only be at a school they teach at, they cannot touch
-- anything already verified, and they cannot move anything anywhere. And they
-- can delete their own unverified rows, so their own typo is theirs to undo
-- rather than a manager's to clean up (YMU 2026-09-04).
--
-- Note this is the shape the inventory already reached for once, in
-- availability_runs: created_by, confirmed_by, confirmed_at on the table
-- itself. When it needed "one person does a pass, another confirms", it did
-- not use the queue either.
-- ===========================================================================

-- created_by defaults to the caller rather than relying on every client to
-- remember: the teacher policies below key off it, so a form that forgot to
-- send it would produce an insert the policy rejects with nothing useful to
-- say. Null when a SECURITY DEFINER function inserts with no signed-in user,
-- which is why the column stays nullable.
alter table public.inv_items
  -- `auth.uid()` bare, not `(select auth.uid())`: the subquery wrapper is a
  -- policy optimisation and DEFAULT does not accept a subquery at all.
  add column created_by  uuid references public.profiles (id) on delete set null
                         default auth.uid(),
  add column verified_at timestamptz,
  add column verified_by uuid references public.profiles (id) on delete set null;

-- One-directional on purpose. The obvious version — "both null or both set" —
-- would make deleting a departed manager's profile FAIL: verified_by is
-- `on delete set null`, which would leave verified_at set and violate the
-- constraint, and Postgres would refuse the delete rather than the null. The
-- ledger outlives its author; a verification whose verifier has left the
-- organisation is still a verification, it just no longer has a name on it.
alter table public.inv_items
  add constraint inv_items_verifier_needs_time check (
    verified_by is null or verified_at is not null
  );

comment on column public.inv_items.verified_at is
  'When a manager confirmed this row is really what is at that school. Null '
  'means a teacher entered it and nobody has checked yet — which is a usable '
  'state, not a pending one.';

comment on column public.inv_items.created_by is
  'Who entered the row. Load-bearing, not decorative: it is what scopes a '
  'teacher to editing and deleting their own count rather than a colleague''s '
  'at the same school.';

-- The manager worklist: unverified rows, newest first, by place.
create index inv_items_unverified_idx
  on public.inv_items (location_id, created_at desc)
  where verified_at is null and retired_at is null;

-- ---------------------------------------------------------------------------
-- Serials are immutable.
--
-- Nothing to do with teachers specifically — it is the label physically stuck
-- to the instrument, and the number in the database has to keep matching it
-- for anyone, manager included. Cheaper to state once here than to trust every
-- future write path to leave it alone.
-- ---------------------------------------------------------------------------

create or replace function public.inv_items_serial_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.serial is distinct from old.serial then
    raise exception 'A serial cannot be changed once assigned (% -> %)',
      old.serial, new.serial
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger t_inv_items_serial_immutable
  before update on public.inv_items
  for each row execute function public.inv_items_serial_is_immutable();

-- ---------------------------------------------------------------------------
-- What a teacher may do.
--
-- Policies are permissive and OR together with the manager policies from 0102,
-- so nothing a manager could do gets narrower. Reading is already handled
-- there: a teacher sees items wherever they can see the place.
--
-- The `with check` on every one of these repeats `verified_at is null`. That
-- is what stops a teacher verifying their own count — without it, an UPDATE
-- could set the column and the whole review step would be optional.
-- ---------------------------------------------------------------------------

-- Add: at a school they teach at, as themselves, unverified.
create policy inv_items_teacher_insert on public.inv_items
  for insert to authenticated
  with check (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and verified_at is null
    and retired_at is null
    and exists (
      select 1 from public.inv_locations l
       where l.id = location_id
         and l.location_type = 'School'
         and public.teacher_has_scheduled_school(l.school_id)
    )
  );

-- Correct their own, while it is still unverified. Both clauses are needed:
-- `using` decides which rows they may touch, `with check` decides what the row
-- may become — without the second they could edit a row of their own into
-- somebody else's school, or mark it verified.
create policy inv_items_teacher_update on public.inv_items
  for update to authenticated
  using (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and verified_at is null
  )
  with check (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and verified_at is null
    and exists (
      select 1 from public.inv_locations l
       where l.id = location_id
         and l.location_type = 'School'
         and public.teacher_has_scheduled_school(l.school_id)
    )
  );

-- Undo their own mistake. Only their own, only unverified: once a manager has
-- confirmed a row it is the organisation's record, not the counter's.
create policy inv_items_teacher_delete on public.inv_items
  for delete to authenticated
  using (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and verified_at is null
  );

-- Photos of their own unverified rows, same reasoning.
create policy inv_attachments_teacher_write on public.inv_attachments
  for all to authenticated
  using (
    public.current_app_role() = 'teacher'
    and exists (
      select 1 from public.inv_items i
       where i.id = item_id
         and i.created_by = (select auth.uid())
         and i.verified_at is null
    )
  )
  with check (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.inv_items i
       where i.id = item_id
         and i.created_by = (select auth.uid())
         and i.verified_at is null
    )
  );
