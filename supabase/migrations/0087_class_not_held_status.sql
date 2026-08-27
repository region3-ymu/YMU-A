-- ===========================================================================
-- 0087 — a class that did not happen is not "on time"
-- ===========================================================================
--
-- YMU 2026-08-27: "a la hora de corregir un attendance lo pone como on time o
-- late pero si no hubo clases no hubo tardanza ni a tiempo."
--
-- Correct, and the form forced a choice between two answers that were both
-- false. clock_in_status has only ever allowed 'on_time' or 'late', so a class
-- recorded as class_not_held was stored as on_time — which then counted as a
-- class TAUGHT in Reports and on the spreadsheet.
--
-- ── Why this is not simply "don't count it" ──────────────────────────────
--
-- YMU raised the thing that matters more than the code: a cancelled class is
-- still PAID. So the number was being asked to mean two different things —
-- "we owe them for this" and "a lesson happened" — and no single answer to
-- "does it count?" can be right for both.
--
-- So they are separated instead:
--
--   HOURS         keeps counting it. Hours are computed from the class's
--                 scheduled length as soon as a session exists, regardless of
--                 status, so pay is already correct and this migration does
--                 not touch it.
--   CLASSES       stops counting it. No lesson was delivered.
--   NOT HELD      becomes its own visible count beside the others, so the
--                 cancelled classes are separated rather than hidden.
--
-- A manager reading Reports now sees "Classes 17 · Not held 2 · Hours 25.5"
-- and neither number is lying.
--
-- ── The trap in the aggregator ───────────────────────────────────────────
--
-- src/lib/reports/aggregate.ts ends its status branch with a bare `else
-- upcoming += 1`. Any new status silently becomes "upcoming" — a class that
-- did not happen would have been counted as one that has not happened YET.
-- The TypeScript change in this commit makes that branch explicit.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The new status
-- ---------------------------------------------------------------------------
-- Same shape as 0052 widening `origin` for 'exempt' and 0077 for 'carryover':
-- a status the app writes must be distinguishable from one a teacher produced.

alter table public.attendance_sessions
  drop constraint if exists attendance_clock_in_status_check;

alter table public.attendance_sessions
  add constraint attendance_clock_in_status_check
  check (clock_in_status in ('on_time', 'late', 'not_held'));

comment on column public.attendance_sessions.clock_in_status is
  'on_time / late describe a clock-in. not_held means the class did not happen: it still pays (hours come from the scheduled length) but it is not a class taught, and no clock-in time is being claimed.';

-- ---------------------------------------------------------------------------
-- 2. Both manager forms write it
-- ---------------------------------------------------------------------------
-- The reason is authoritative over the status the form sent. A manager who
-- picks "Class did not happen" has already answered the on-time question; the
-- select is hidden in the UI for that reason, and this makes the rule true even
-- if something else calls the function.
--
-- Bodies are 0085's verbatim apart from the status expression.

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
  v_no_feedback boolean := p_reason = 'class_not_held';
  v_due timestamptz;
  v_status text;
begin
  if v_uid is null or v_role not in (
    'regional_manager', 'afterschool_manager', 'academic_manager',
    'operations_manager', 'administrator', 'cpo'
  ) then
    raise exception 'Only a manager can record attendance.';
  end if;
  -- 'not_held' is accepted from the caller too, so the UI can send it directly.
  if p_clock_in_status not in ('on_time', 'late', 'not_held') then
    raise exception 'clock_in_status must be on_time, late or not_held.';
  end if;

  v_note := public.flag_resolution_note('Recorded by manager: ', p_reason, p_reason_notes);

  -- The reason wins. There is no such thing as arriving on time to a class
  -- that did not happen.
  v_status := case when v_no_feedback then 'not_held' else p_clock_in_status end;

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

  -- 0085: floored at now() + 24h so a back-dated entry is never born overdue.
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
    p_teacher_id, p_event_id, v_event.school_id, p_clock_in_at, v_status,
    v_event.start_at, v_event.end_at,
    v_due,
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
  'Records attendance a teacher never clocked in for. class_not_held forces status not_held and owes no feedback; the deadline is otherwise floored at now() + 24 hours so a back-dated entry cannot be born overdue.';

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) to authenticated;

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
  if p_clock_in_status is not null and p_clock_in_status not in ('on_time', 'late', 'not_held') then
    raise exception 'clock_in_status must be on_time, late or not_held.';
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
     set clock_in_status   = case
                               when v_no_feedback then 'not_held'
                               else coalesce(p_clock_in_status, clock_in_status)
                             end,
         clock_in_at       = coalesce(p_clock_in_at, clock_in_at),
         admin_edited_at   = now(),
         admin_edited_by   = v_uid,
         admin_edit_reason = v_note,
         -- 0085: only class_not_held touches the feedback demand here.
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
  'Corrects an existing attendance session. class_not_held forces status not_held and clears any feedback still owed; no other reason touches either.';

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The one that already exists
-- ---------------------------------------------------------------------------
-- Cristian Perez's Modern Band, recorded 2026-08-27 as a class that did not
-- happen and stored as on_time. Its 1.08 hours stay — he is paid for it — but
-- it stops counting as a class taught.
--
-- Matched on the note rather than a hardcoded id so a replay finds whatever is
-- in that state, and narrow enough that it cannot catch a real clock-in.

update public.attendance_sessions a
   set clock_in_status = 'not_held'
 where a.clock_in_status <> 'not_held'
   and a.origin = 'admin'
   and a.admin_edit_reason like '%: Class did not happen%';
