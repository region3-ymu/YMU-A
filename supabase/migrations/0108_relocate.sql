-- ===========================================================================
-- 0108 — moving instruments, and writing it down
-- ===========================================================================
--
-- 0102 made inv_movements insert-only: a select policy and nothing else, for
-- anyone. This is the function that fills it. Everything a move has to do —
-- record it, change where the item is, update who is holding it — happens in
-- one statement each, inside one transaction, so there is no ordering in which
-- an item ends up moved with no record, or a record exists for a move that did
-- not happen.
--
-- SECURITY DEFINER because it must write a table nobody can insert into. That
-- means RLS is bypassed and every rule it would have applied has to be applied
-- here instead, explicitly. The checks below are that, not defensive padding.
--
-- HANDING AN INSTRUMENT TO A STUDENT IS A MOVE. Since 0101 a student is not a
-- place, so "Ana takes violin 37 home" does not change the item's location —
-- it sets assigned_student_name, and the movement records the handoff with
-- from and to being the same school. That reads oddly as a "relocation" and is
-- right as history: something happened to that instrument on that date, and a
-- ledger that only recorded changes of address would not show it.
--
-- Passing no student name clears the field. That is deliberate and is the
-- whole reason clearing lives in this function rather than in the app: an
-- instrument that comes back from a student and a manager who forgets to blank
-- the name would leave the roster claiming a child still has it.
-- ===========================================================================

create or replace function public.inv_relocate_items(
  p_item_ids           uuid[],
  p_to_location_id     uuid,
  p_relocation_type_id uuid default null,
  p_notes              text default null,
  p_student_name       text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_manager boolean := public.inventory_manager();
  v_role       public.app_role := public.current_app_role();
  v_actor      uuid := auth.uid();
  v_student    text := nullif(btrim(coalesce(p_student_name, '')), '');
  v_count      integer;
  v_bad        text;
begin
  if not v_is_manager and v_role is distinct from 'teacher' then
    raise exception 'Your role cannot move inventory';
  end if;

  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception 'Select at least one item to move';
  end if;
  -- The cap is not about performance. It is so one mis-selected checkbox
  -- cannot relocate an entire region in a single click.
  if array_length(p_item_ids, 1) > 500 then
    raise exception 'A move is limited to 500 items at a time';
  end if;

  if not exists (
    select 1 from public.inv_locations
     where id = p_to_location_id and active
  ) then
    raise exception 'That destination does not exist, or is no longer in use';
  end if;

  -- Named rather than counted: "3 of the items you selected no longer exist"
  -- sends someone hunting. Listing the serials tells them which ones.
  select string_agg(x.id::text, ', ')
    into v_bad
    from unnest(p_item_ids) as x(id)
   where not exists (
     select 1 from public.inv_items i
      where i.id = x.id and i.retired_at is null
   );
  if v_bad is not null then
    raise exception 'These items no longer exist or have been retired: %', v_bad;
  end if;

  -- ---------------------------------------------------------------------
  -- What a teacher may do, restated because DEFINER skipped the policies.
  -- Kept identical to 0104's rules on purpose: two answers to "may this
  -- teacher move this instrument" is one answer too many.
  -- ---------------------------------------------------------------------
  if not v_is_manager then
    if not exists (
      select 1 from public.inv_locations l
       where l.id = p_to_location_id
         and l.location_type = 'School'
         and public.teacher_has_scheduled_school(l.school_id)
    ) then
      raise exception
        'You can only move instruments to a school you teach at';
    end if;

    select string_agg(i.serial, ', ')
      into v_bad
      from public.inv_items i
     where i.id = any(p_item_ids)
       and not exists (
         select 1 from public.inv_locations l
          where l.id = i.location_id
            and l.location_type = 'School'
            and public.teacher_has_scheduled_school(l.school_id)
       );
    if v_bad is not null then
      raise exception
        'These are not at a school you teach at: %', v_bad;
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- The ledger first. from_location_id is read off the item before it moves,
  -- which is the only moment it is available — this is why the insert comes
  -- before the update and not after.
  -- ---------------------------------------------------------------------
  insert into public.inv_movements (
    item_id, from_location_id, to_location_id, relocation_type_id,
    student_name, moved_by, notes
  )
  select i.id, i.location_id, p_to_location_id, p_relocation_type_id,
         v_student, v_actor, nullif(btrim(coalesce(p_notes, '')), '')
    from public.inv_items i
   where i.id = any(p_item_ids);

  get diagnostics v_count = row_count;

  update public.inv_items
     set location_id           = p_to_location_id,
         assigned_student_name = v_student,
         -- A teacher's move returns the row to the manager worklist, exactly
         -- as an edit through the policy in 0104 would have.
         verified_at           = case when v_is_manager then verified_at else null end,
         verified_by           = case when v_is_manager then verified_by else null end,
         updated_at            = now()
   where id = any(p_item_ids);

  return v_count;
end;
$$;

revoke execute on function public.inv_relocate_items(uuid[], uuid, uuid, text, text)
  from public, anon;
grant execute on function public.inv_relocate_items(uuid[], uuid, uuid, text, text)
  to authenticated;

comment on function public.inv_relocate_items(uuid[], uuid, uuid, text, text) is
  'Moves items, writes the movement, and sets or clears who is holding them. '
  'The only writer of inv_movements. Passing no student name clears the field, '
  'so an instrument coming back from a student cannot leave a child''s name '
  'attached to it.';
