-- ===========================================================================
-- 0085 — a manager correcting attendance must not punish the teacher
-- ===========================================================================
--
-- What happened in production, 2026-08-27:
--
--   Pedro Diaz recorded Cristian Perez's Modern Band class at Edison Park with
--   the reason 'class_not_held'. The class ended 2026-08-26 11:00. He recorded
--   it 2026-08-27 13:18. admin_create_attendance() computes
--   feedback_due_at = end_at + 24 hours = 2026-08-27 11:00 — over two hours
--   BEFORE the row existed.
--
--   The session was born overdue, clock_in() refuses anyone with overdue
--   feedback, and Cristian could not clock in. A manager doing him a favour
--   locked him out.
--
-- Two faults in one expression, and the second is the sillier one: the reason
-- recorded was that the class DID NOT HAPPEN, and the app still demanded a form
-- asking which objectives were worked and how engaged the students were.
--
-- Not introduced recently — that arithmetic dates to 0023. It surfaced now
-- because 0076's reason dropdown made managers record more of these than the
-- old free-text box ever did.
--
-- ── The two fixes, as YMU chose them ─────────────────────────────────────
--
-- 1. The deadline gets a floor of now() + 24 hours, via greatest(). A teacher
--    always has a real day to answer, counted from when the demand actually
--    came into existence.
--
--    greatest() rather than "only when it would already be expired": that
--    version leaves a window where a class recorded 23 hours late gives the
--    teacher one hour, which is the same unfairness in miniature. greatest()
--    is one rule with no cliff, and is never worse for the teacher. For a
--    class recorded the same day it moves the deadline by hours at most.
--
-- 2. 'class_not_held' owes no feedback at all, whatever the dates.
--
--    YMU: "class not held no debería pedir feedback nunca." Applied in
--    admin_edit_attendance() as well as admin_create_attendance(), because
--    "never" includes a manager who marks an EXISTING session as a class that
--    did not happen — that session is already carrying a demand.
--
--    The floor from fix 1 is NOT added to admin_edit_attendance. It never
--    touches feedback_due_at (verified: zero references in its body), so it
--    cannot create an expired demand, and giving it the power to rewrite a
--    deadline would be a new behaviour nobody asked for.
--
-- Reuses the pair 0081 established for a class that owes no form —
-- feedback_due_at = null with feedback_settled_at stamped — rather than
-- inventing a third way to say the same thing. has_overdue_feedback() reads
-- both halves, so both are needed.
--
-- Bodies below are 0076's verbatim apart from the feedback expressions.
-- ===========================================================================

drop function if exists public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text);

create or replace function public.admin_create_attendance(
  p_event_id        uuid,
  p_teacher_id      uuid,
  p_clock_in_at     timestamptz,
  p_clock_in_status text,
  p_reason          text,
  p_reason_notes    text default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_event public.calendar_events;
  v_school_region public.region;
  v_row public.attendance_sessions;
  v_clock_out timestamptz;
  v_note text;
  -- The class did not happen, so there is nothing to reflect on.
  v_no_feedback boolean := p_reason = 'class_not_held';
  v_due timestamptz;
begin
  if v_uid is null or v_role not in (
    'regional_manager', 'afterschool_manager', 'academic_manager',
    'operations_manager', 'administrator', 'cpo'
  ) then
    raise exception 'Only a manager can record attendance.';
  end if;
  if p_clock_in_status not in ('on_time', 'late') then
    raise exception 'clock_in_status must be on_time or late.';
  end if;

  v_note := public.flag_resolution_note('Recorded by manager: ', p_reason, p_reason_notes);

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'Class not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_event.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only record attendance for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager'
    and not public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
    raise exception 'You can only record attendance on afterschool classes.';
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

  -- THE FIX. Was: v_event.end_at + interval '24 hours', full stop — which is
  -- in the past for any class recorded more than a day late, and the session
  -- was overdue the moment it existed.
  v_due := case
    when v_no_feedback then null
    when v_event.end_at is null then null
    else greatest(v_event.end_at + interval '24 hours', now() + interval '24 hours')
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id, clock_in_at, clock_in_status,
    scheduled_start_at, scheduled_end_at, feedback_due_at, feedback_settled_at,
    clock_out_at, clock_out_source,
    origin, admin_edited_at, admin_edited_by, admin_edit_reason
  )
  values (
    p_teacher_id, p_event_id, v_event.school_id, p_clock_in_at, p_clock_in_status,
    v_event.start_at, v_event.end_at,
    v_due,
    -- Both halves, because has_overdue_feedback() reads both: a null due date
    -- keeps it out of the overdue count, the settled stamp keeps it off the
    -- teacher's pending list.
    case when v_no_feedback then now() end,
    v_clock_out,
    case when v_clock_out is null then null else 'admin' end,
    'admin', now(), v_uid, v_note
  )
  returning * into v_row;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'resolution_reason', p_reason,
           'resolution_notes',  v_note
         )
   where type = 'late_clock_in'
     and event_id = p_event_id
     and teacher_id = p_teacher_id
     and resolved_at is null;

  return v_row;
end;
$$;

comment on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) is
  'Records attendance a teacher never clocked in for. The feedback deadline is floored at now() + 24 hours so a back-dated entry cannot be born overdue, and a class recorded as class_not_held owes no feedback at all.';

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_edit_attendance: only the class_not_held half
-- ---------------------------------------------------------------------------

drop function if exists public.admin_edit_attendance(uuid, text, timestamptz, text, text);

create or replace function public.admin_edit_attendance(
  p_session_id      uuid,
  p_clock_in_status text,
  p_clock_in_at     timestamptz,
  p_reason          text,
  p_reason_notes    text default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_row  public.attendance_sessions;
  v_school_region public.region;
  v_note text;
  v_no_feedback boolean := p_reason = 'class_not_held';
begin
  if v_uid is null or v_role not in (
    'regional_manager', 'afterschool_manager', 'academic_manager',
    'operations_manager', 'administrator', 'cpo'
  ) then
    raise exception 'Only a manager can edit attendance.';
  end if;
  if p_clock_in_status is not null and p_clock_in_status not in ('on_time', 'late') then
    raise exception 'clock_in_status must be on_time or late.';
  end if;

  v_note := public.flag_resolution_note('Attendance corrected by manager: ', p_reason, p_reason_notes);

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'Attendance session not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned_event(v_row.event_id) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_row.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only edit attendance for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager' and not public.afterschool_owned_event(v_row.event_id) then
    raise exception 'You can only edit attendance on afterschool classes.';
  end if;

  update public.attendance_sessions
     set clock_in_status   = coalesce(p_clock_in_status, clock_in_status),
         clock_in_at       = coalesce(p_clock_in_at, clock_in_at),
         admin_edited_at   = now(),
         admin_edited_by   = v_uid,
         admin_edit_reason = v_note,
         -- New in 0085, and the ONLY feedback change here. Marking an existing
         -- session as a class that did not happen clears the demand it is
         -- already carrying. Everything else leaves the deadline exactly as it
         -- was — this function has never set it and is not starting now.
         feedback_due_at     = case when v_no_feedback then null else feedback_due_at end,
         feedback_settled_at = case
                                 when v_no_feedback then coalesce(feedback_settled_at, now())
                                 else feedback_settled_at
                               end
   where id = p_session_id
   returning * into v_row;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'resolution_reason', p_reason,
           'resolution_notes',  v_note
         )
   where type = 'late_clock_in'
     and event_id = v_row.event_id
     and teacher_id = v_row.teacher_id
     and resolved_at is null;

  return v_row;
end;
$$;

comment on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) is
  'Corrects an existing attendance session. Marking it class_not_held clears any feedback still owed; no other reason touches the deadline.';

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Anything already born overdue
-- ---------------------------------------------------------------------------
-- One row at the time of writing: Cristian Perez's Modern Band, settled by
-- hand before this migration so he could clock in again. This is here so a
-- replay on another database, or a row created between now and the deploy,
-- gets the same treatment. Deliberately narrow: only sessions whose deadline
-- was ALREADY past when the row was created, and only where no feedback of
-- any kind has been collected.

update public.attendance_sessions a
   set feedback_due_at = null,
       feedback_settled_at = coalesce(a.feedback_settled_at, now())
 where a.feedback_settled_at is null
   and a.feedback_due_at is not null
   and a.feedback_due_at < a.created_at
   and a.feedback_submitted_at is null
   and a.relay_feedback_submitted_at is null
   and not exists (
     select 1 from public.feedback_submissions f where f.session_id = a.id
   );
