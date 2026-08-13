-- A class a manager records by hand still owes its feedback.
--
-- `admin_create_attendance()` exists for the teacher who genuinely taught but
-- never clocked in. It writes the session — but not `scheduled_end_at` or
-- `feedback_due_at`, which are the two columns the entire feedback obligation
-- hangs off (0026). The row therefore says the class happened while every
-- reader of "who owes feedback" skips it: it never appears on /feedback, never
-- blocks the next clock-in, and never reaches the spreadsheet.
--
-- That is backwards from what recording attendance means. YMU's point when
-- they reported it: marking the class as taught should carry the same duty as
-- clocking in for it, because it is the same claim — I was there, I taught it.
-- Otherwise the tidier path for a teacher is to skip clock-in and have a
-- manager record it, which buys them out of the form entirely.
--
-- Copied from clock_in()'s own insert rather than invented, including the null
-- guard: a class with no scheduled end gets no deadline and never blocks,
-- which is the same rule the clock-in path already applies.

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

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id, clock_in_at, clock_in_status,
    scheduled_start_at, scheduled_end_at, feedback_due_at,
    origin, admin_edited_at, admin_edited_by, admin_edit_reason
  )
  values (
    p_teacher_id, p_event_id, v_event.school_id, p_clock_in_at, p_clock_in_status,
    v_event.start_at, v_event.end_at,
    -- Same 24-hour window, measured from the class's scheduled end, that
    -- clock_in() applies. Null end means no deadline, so it never blocks.
    case when v_event.end_at is null then null else v_event.end_at + interval '24 hours' end,
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
