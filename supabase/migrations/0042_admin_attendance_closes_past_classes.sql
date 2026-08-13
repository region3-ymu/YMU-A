-- "duplicate key value violates unique constraint
--  attendance_one_open_session_per_teacher" when recording a second class.
--
-- That index is `unique (teacher_id) where clock_out_at is null` — a teacher
-- can be in at most one class at a time, which is right and worth keeping.
--
-- `admin_create_attendance()` never set `clock_out_at`, so every class a
-- manager recorded was written as STILL IN PROGRESS. Recording one class was
-- fine. Recording a second for the same teacher — exactly what a manager does
-- when fixing up a day's worth of missed clock-ins — collided with the first,
-- and the error named an index rather than the problem.
--
-- YMU put it precisely: recording attendance should leave the class finished
-- with its feedback pending, not pretend the teacher is standing in the room.
--
-- So the class is closed when it has already ended, and left open only when it
-- genuinely is still running — which preserves what the index means instead of
-- working around it. Two consequences worth stating:
--
--   * `clock_out_at` is set to the class's scheduled END, never `now()`. A
--     manager fixing Tuesday's register on Thursday must not create two days of
--     phantom attendance. (Pay is unaffected either way —
--     `attendance_period_rows.hours_worked` has been the SCHEDULED duration
--     since 0021 — but the timestamp is still read by humans.)
--   * A class still in progress stays open, so the teacher's own app continues
--     to show it as their current class and the auto-clock-out sweep closes it
--     at the end, exactly as for a normal clock-in.
--
-- feedback_due_at is untouched (0037): the obligation is independent of whether
-- the session is open, which is the whole point of 0026's split.

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
    raise exception 'An attendance record already exists for this class/teacher — edit it instead.';
  end if;

  -- Closed if the class is over, open if it is genuinely still running.
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

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = details || jsonb_build_object('resolution_notes', 'Recorded by manager: ' || btrim(p_reason))
   where event_id = p_event_id and teacher_id = p_teacher_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text)
  from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text)
  to authenticated;

-- Anything already recorded by a manager for a class that has since ended is
-- still sitting open and still blocking that teacher's next record. Close them
-- on the same rule.
update public.attendance_sessions a
   set clock_out_at = e.end_at,
       clock_out_source = coalesce(a.clock_out_source, 'admin')
  from public.calendar_events e
 where e.id = a.event_id
   and a.origin = 'admin'
   and a.clock_out_at is null
   and e.end_at is not null
   and e.end_at <= now();
