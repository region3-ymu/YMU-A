-- ===========================================================================
-- 0104 — teachers move instruments too, and the move needs verifying
-- ===========================================================================
--
-- 0103 let a teacher add and correct their own count but not move anything.
-- YMU 2026-09-04: they should be able to move instruments as well, on the same
-- terms — the move lands immediately, flagged unverified, and a manager
-- confirms it.
--
-- That makes verified_at mean something slightly broader than it did
-- yesterday: not "a manager confirmed this row exists" but "a manager
-- confirmed this row as it currently stands". Any teacher write invalidates
-- it, whether they created the row or moved it. One flag, one worklist, which
-- is the whole reason this beat the approval queue.
--
-- BETWEEN THEIR OWN SCHOOLS ONLY. Storage and repair shops are deliberately
-- not destinations a teacher can pick: sending something to a repair shop is
-- the start of a repair, which has its own steps and its own person, and a
-- move that skips those produces an instrument sitting at a shop with no
-- repair attached to it. Widen this if the shape of the work turns out to
-- disagree — the constraint is one clause below, not a design assumption
-- spread across the schema.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Replace 0103's update policy. Two changes: a teacher may now touch a row at
-- any of their schools rather than only their own unverified rows, and the
-- result must land at one of their schools and come back unverified.
--
-- The `with check` still carries `verified_at is null`, which is now doing two
-- jobs: it stops a teacher verifying their own work, and it is what makes a
-- teacher's move un-verify the row rather than silently keeping a manager's
-- old confirmation attached to a state that manager never saw.
-- ---------------------------------------------------------------------------

drop policy if exists inv_items_teacher_update on public.inv_items;

create policy inv_items_teacher_update on public.inv_items
  for update to authenticated
  using (
    public.current_app_role() = 'teacher'
    and retired_at is null
    and exists (
      select 1 from public.inv_locations l
       where l.id = location_id
         and l.location_type = 'School'
         and public.teacher_has_scheduled_school(l.school_id)
    )
  )
  with check (
    public.current_app_role() = 'teacher'
    -- Any teacher edit returns the row to the manager worklist.
    and verified_at is null
    and retired_at is null
    and exists (
      select 1 from public.inv_locations l
       where l.id = location_id
         and l.location_type = 'School'
         and public.teacher_has_scheduled_school(l.school_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Close the hole the change above opens.
--
-- 0103's delete rule was "your own row, still unverified". That was airtight
-- while a teacher could not un-verify anything. Now they can: create a row,
-- have a manager verify it, move it — which clears verified_at — and it is
-- deletable again. A verified record would be destroyable by whoever entered
-- it, in two steps, with no trace.
--
-- The guard is that a row which has ever moved has a movement, and movements
-- are insert-only. A miscount noticed thirty seconds later has none and stays
-- deletable, which is the case this permission exists for.
-- ---------------------------------------------------------------------------

drop policy if exists inv_items_teacher_delete on public.inv_items;

create policy inv_items_teacher_delete on public.inv_items
  for delete to authenticated
  using (
    public.current_app_role() = 'teacher'
    and created_by = (select auth.uid())
    and verified_at is null
    and not exists (
      select 1 from public.inv_movements m where m.item_id = inv_items.id
    )
  );

comment on column public.inv_items.verified_at is
  'When a manager last confirmed this row as it currently stands. Cleared by '
  'any teacher write — adding, correcting or moving — so the worklist is '
  'always "what has changed since a manager last looked". Null is a usable '
  'state, not a pending one.';
