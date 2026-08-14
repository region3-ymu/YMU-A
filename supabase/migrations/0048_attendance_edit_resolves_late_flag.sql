-- Make "sort out this attendance" actually close the flag it came from.
--
-- Three related defects, all reported as one thing: "I resolve a missing
-- attendance and it keeps showing on the flag part."
--
-- 1. admin_edit_attendance() touched no flags at all. Recording a *new*
--    attendance (admin_create_attendance) has closed the flag since 0037, but
--    the far more common case on a late_clock_in card is a teacher who has
--    since clocked in themselves — that is an EDIT, and it left the flag open
--    with nothing on the card able to close it.
--
-- 2. admin_create_attendance()'s flag update had no `type` filter, so
--    recording an attendance also silently cleared any gps_out_of_fence or
--    feedback_stuck flag on the same (event, teacher). Those are different
--    questions — "were they at the school" and "did they log the class" — and
--    recording attendance answers neither.
--
-- 3. Backfill at the bottom: 0044 only auto-resolves flags on NEW clock-ins,
--    so every teacher who arrived a minute or two late before it shipped is
--    still flagged. Applying the same 15-minute rule retroactively clears
--    those without touching the ones a manager should genuinely look at.

create or replace function public.admin_edit_attendance(
  p_session_id uuid,
  p_clock_in_status text default null,
  p_clock_in_at timestamptz default null,
  p_reason text default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_row public.attendance_sessions;
  v_school_region public.region;
begin
  if v_uid is null or v_role not in ('regional_manager', 'operations_manager', 'cpo') then
    raise exception 'Only a regional manager, operations manager, or the CPO can edit attendance.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to edit an attendance record.';
  end if;
  if p_clock_in_status is not null and p_clock_in_status not in ('on_time', 'late') then
    raise exception 'clock_in_status must be on_time or late.';
  end if;

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'Attendance session not found.';
  end if;

  if v_role = 'regional_manager' then
    select s.region into v_school_region from public.schools s where s.id = v_row.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only edit attendance for schools in your own region.';
    end if;
  end if;

  update public.attendance_sessions
     set clock_in_status = coalesce(p_clock_in_status, clock_in_status),
         clock_in_at = coalesce(p_clock_in_at, clock_in_at),
         admin_edited_at = now(),
         admin_edited_by = v_uid,
         admin_edit_reason = btrim(p_reason)
   where id = p_session_id
   returning * into v_row;

  -- A manager has now reviewed this class's attendance and put it right, which
  -- is exactly what the late_clock_in flag was asking someone to do. Only that
  -- type: an out-of-fence GPS reading or an unlogged class is a separate
  -- question this edit does not answer.
  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb)
           || jsonb_build_object('resolution_notes', 'Attendance corrected by manager: ' || btrim(p_reason))
   where type = 'late_clock_in'
     and event_id = v_row.event_id
     and teacher_id = v_row.teacher_id
     and resolved_at is null;

  return v_row;
end;
$$;

comment on function public.admin_edit_attendance(uuid, text, timestamptz, text) is
  'Corrects an attendance session and closes this class''s late_clock_in flag — a manager who has just fixed the record is the review that flag was waiting for. Deliberately leaves gps_out_of_fence and feedback_stuck alone; those ask different questions.';

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_create_attendance: same narrowing
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_attendance(
  p_event_id uuid,
  p_teacher_id uuid,
  p_clock_in_at timestamptz,
  p_clock_in_status text,
  p_reason text
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_event public.calendar_events;
  v_school_region public.region;
  v_row public.attendance_sessions;
  v_clock_out timestamptz;
begin
  if v_uid is null or v_role not in ('regional_manager', 'operations_manager', 'cpo') then
    raise exception 'Only a regional manager, operations manager, or the CPO can record attendance.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to record a missed attendance.';
  end if;
  if p_clock_in_status not in ('on_time', 'late') then
    raise exception 'clock_in_status must be on_time or late.';
  end if;

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'Class not found.';
  end if;

  if v_role = 'regional_manager' then
    select s.region into v_school_region from public.schools s where s.id = v_event.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only record attendance for schools in your own region.';
    end if;
  end if;

  if exists (
    select 1 from public.attendance_sessions
    where event_id = p_event_id and teacher_id = p_teacher_id
  ) then
    raise exception 'An attendance record already exists for this class/teacher - edit it instead.';
  end if;

  v_clock_out := case
    when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at
    else null
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id, clock_in_at, clock_in_status,
    scheduled_start_at, scheduled_end_at, feedback_due_at,
    clock_out_at, clock_out_source,
    origin, admin_edited_at, admin_edited_by, admin_edit_reason
  )
  values (
    p_teacher_id, p_event_id, v_event.school_id, p_clock_in_at, p_clock_in_status,
    v_event.start_at, v_event.end_at,
    case when v_event.end_at is null then null else v_event.end_at + interval '24 hours' end,
    v_clock_out,
    case when v_clock_out is null then null else 'admin' end,
    'admin', now(), v_uid, btrim(p_reason)
  )
  returning * into v_row;

  -- Scoped to late_clock_in (see the header). This used to close every open
  -- flag on the (event, teacher) pair.
  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb)
           || jsonb_build_object('resolution_notes', 'Recorded by manager: ' || btrim(p_reason))
   where type = 'late_clock_in'
     and event_id = p_event_id
     and teacher_id = p_teacher_id
     and resolved_at is null;

  return v_row;
end;
$$;

comment on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text) is
  'Records attendance for a class the teacher never clocked into, closing that class''s late_clock_in flag. Past classes are also clocked out at their scheduled end (0042) so they do not sit open forever.';

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text) from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: apply 0044's rule to flags raised before it shipped
-- ---------------------------------------------------------------------------
-- Same 15-minute grace clock_in() now uses. Teachers who turned up later than
-- that stay flagged on purpose — that is the case a manager should see, and
-- from now on the card can actually clear it.
update public.flags f
   set resolved_at = now(),
       details = coalesce(f.details, '{}'::jsonb) || jsonb_build_object(
         'auto_resolved_by', 'backfill_0048',
         'clock_in_at', a.clock_in_at,
         'minutes_late', floor(extract(epoch from (a.clock_in_at - ce.start_at)) / 60)::integer
       )
  from public.attendance_sessions a
  join public.calendar_events ce on ce.id = a.event_id
 where f.type = 'late_clock_in'
   and f.resolved_at is null
   and a.event_id = f.event_id
   and a.teacher_id = f.teacher_id
   and ce.start_at is not null
   and a.clock_in_at <= ce.start_at + interval '15 minutes';
