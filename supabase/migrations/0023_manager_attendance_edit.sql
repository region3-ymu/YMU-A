-- Manager-side attendance correction, requested live during the Relay week:
-- a teacher can genuinely give a class and never manage to clock in (phone
-- died, no signal, forgot), or get flagged "late" when they weren't. Until
-- now NO role could touch attendance_sessions except the teacher's own
-- clock_in() and Zoho's close_session_from_zoho() (see DECISIONS.md/
-- HANDOFF.md — this was a known, deliberate gap, not an oversight). The
-- user's paper backup this week is the workaround; this migration finally
-- gives regional_manager/operations_manager/cpo a real, audited way to fix
-- the record from the reconciled paper log, instead of living with a
-- permanently wrong "missed"/"late" row.
--
-- Client-side, the caller must re-enter THEIR OWN password immediately
-- before submitting (a plain supabase.auth.signInWithPassword() re-check —
-- no new RPC needed for that half) — this migration only adds the
-- server-side mutation + audit trail once that gate has passed.

-- ---------------------------------------------------------------------------
-- 1. Audit trail columns — who touched this record administratively, when,
--    and why. Nullable: null on every normal (non-admin) row.
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions
  add column admin_edited_at timestamptz,
  add column admin_edited_by uuid references public.profiles (id),
  add column admin_edit_reason text;

comment on column public.attendance_sessions.admin_edited_at is
  'Set only when a manager corrected this row via admin_edit_attendance/admin_create_attendance — when the correction happened, not when the class happened.';
comment on column public.attendance_sessions.admin_edited_by is
  'The manager (regional_manager/operations_manager/cpo) who made the correction.';
comment on column public.attendance_sessions.admin_edit_reason is
  'Required free-text reason the manager gave for the correction (e.g. reconciling against the paper sign-in sheet).';

-- 'admin' joins 'online'/'offline' as a third, honest origin: a class a
-- manager recorded after the fact from the paper log is neither a live device
-- clock-in nor a queued offline replay of one.
alter table public.attendance_sessions
  drop constraint attendance_sessions_origin_check,
  add constraint attendance_sessions_origin_check check (origin in ('online', 'offline', 'admin'));

-- ---------------------------------------------------------------------------
-- 2. admin_edit_attendance: correct an EXISTING session's status/time
--    (the "flagged late but actually on time" / "clock-in time is wrong" case).
-- ---------------------------------------------------------------------------

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

  return v_row;
end;
$$;

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_create_attendance: record a clock-in that never happened at all
--    (the "class ran, teacher never clocked in, we know from the paper log"
--    case — 'missed' in attendance_period_rows, no session row exists yet).
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
    scheduled_start_at, origin, admin_edited_at, admin_edited_by, admin_edit_reason
  )
  values (
    p_teacher_id, p_event_id, v_event.school_id, p_clock_in_at, p_clock_in_status,
    v_event.start_at, 'admin', now(), v_uid, btrim(p_reason)
  )
  returning * into v_row;

  -- Resolve any open flag for this (event, teacher) pair — the thing it was
  -- escalating about (a missing/late clock-in) is now on the record.
  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = details || jsonb_build_object('resolution_notes', 'Recorded by manager: ' || btrim(p_reason))
   where event_id = p_event_id and teacher_id = p_teacher_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text) from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text) to authenticated;
