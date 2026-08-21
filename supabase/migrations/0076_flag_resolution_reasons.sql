-- ===========================================================================
-- 0076 — the six reasons managers keep typing by hand
-- ===========================================================================
--
-- 120 late_clock_in flags in, 49 of the 93 resolved ones carry a note, and
-- those 49 collapse to a handful of causes spelled a dozen ways:
--
--   Forgot to do it (×11) / Forgot (×4) / Forgot it / Forgot tondonit /
--   Present but forgot to clock in (×2)   -- one cause, six spellings
--   Tech problem (×6) / Tech problems (×2) / Mistake / Problem
--   Internet / Internet problems / No internet
--   Schedule problem (×4) / "The actual start time is different from the
--     displayed calendar time."            -- the calendar is wrong, not the teacher
--   programs@ymu.org (×3) / PRUEBA - diagnostico / N/A
--
-- Nothing there is countable, so nobody can answer the only question worth
-- asking: how much of this is our app failing versus teachers forgetting.
-- After this migration the cause is a code and the prose is optional.
--
-- Two decisions worth recording:
--
--   * The label still gets baked into resolution_notes, prefixed exactly as
--     before ("Recorded by manager: ", "Attendance corrected by manager: ").
--     The Flags tab of the spreadsheet has 93 historical rows in that shape
--     and YMU reads it directly; a code alone would make the new rows less
--     legible than the old ones. The code goes in its own key alongside.
--
--   * resolve_flag/admin_edit_attendance/admin_create_attendance are DROPPED
--     and recreated rather than gaining a defaulted parameter. Postgres
--     resolves f(a,b) against both f(a,b) and f(a,b,c default null) as
--     ambiguous, so an added default would break every existing caller at
--     runtime instead of at deploy time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The list, in SQL, once
-- ---------------------------------------------------------------------------
-- A function rather than a table: this list is a decision, not data. It
-- changes when YMU changes its mind about categories, which is a migration —
-- not something a manager should be able to edit into a fifth spelling of
-- "forgot". src/lib/attendance/flag-reasons.ts is its twin and must match;
-- tests/flag-reasons.test.ts asserts the labels are identical.
--
-- STRICT so a null code short-circuits to null rather than scanning the list.

create or replace function public.flag_reason_label(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'forgot'              then 'Forgot to clock in — was there on time'
    when 'tech_problem'        then 'App or phone problem'
    when 'calendar_time_wrong' then 'Calendar time is wrong — class starts later'
    when 'no_internet'         then 'No internet at the school'
    when 'teacher_absent'      then 'Teacher was absent'
    when 'class_not_held'      then 'Class did not happen'
    when 'other'               then 'Other'
  end;
$$;

comment on function public.flag_reason_label(text) is
  'The label for a late-clock-in reason code, or null if the code is not one of the seven. Twin of src/lib/attendance/flag-reasons.ts.';

grant execute on function public.flag_reason_label(text) to authenticated, service_role;

-- One validator, so the same rules hold whichever of the three entry points a
-- manager came through. Returns the note text to store; raises otherwise.
--
-- 'other' demanding prose is the whole point of having it: without that rule
-- "other" becomes the path of least resistance and we are back to 49
-- uncountable notes, only now they all say "Other".

create or replace function public.flag_resolution_note(
  p_prefix text,
  p_code   text,
  p_notes  text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_label text := public.flag_reason_label(p_code);
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if v_label is null then
    raise exception 'Choose a reason. "%" is not one of the seven reasons on the list.', coalesce(p_code, '');
  end if;
  if p_code = 'other' and v_notes is null then
    raise exception 'Choosing "Other" means writing what happened.';
  end if;

  return coalesce(p_prefix, '') || v_label
       || case when v_notes is null then '' else ' — ' || v_notes end;
end;
$$;

comment on function public.flag_resolution_note(text, text, text) is
  'Validates a reason code + optional prose and renders the human-readable resolution note. Raises on an unknown code, or on "other" with nothing written.';

grant execute on function public.flag_resolution_note(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. resolve_flag — it has been throwing the notes away
-- ---------------------------------------------------------------------------
-- The SQL has taken p_notes since 0012. src/app/(app)/flags/actions.ts has
-- never passed it:
--
--     supabase.rpc("resolve_flag", { p_flag_id: flagId })
--
-- so every "Mark resolved" wrote resolution_notes: null. That is why 44 of the
-- 93 resolved flags carry no reason at all — not manager laziness, a dropped
-- argument. p_reason is now required and the caller is fixed in the same
-- change.
--
-- Body is 0065's authorization clause verbatim; only the update at the end and
-- the signature move.

drop function if exists public.resolve_flag(uuid, text);

create or replace function public.resolve_flag(
  p_flag_id uuid,
  p_reason  text,
  p_notes   text default null
)
returns public.flags
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_flag public.flags%rowtype;
  v_note text;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if not (v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions()) then
    raise exception 'Only managers can resolve flags.';
  end if;

  -- Before the region check, so a bad code is never reported as a permission
  -- problem.
  v_note := public.flag_resolution_note('', p_reason, p_notes);

  select * into v_flag from public.flags where id = p_flag_id;
  if not found then
    raise exception 'Flag not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned_event(v_flag.event_id) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    if v_flag.school_id is not null and not exists (
      select 1 from public.schools s
      where s.id = v_flag.school_id and (s.region is null or s.region = public.current_app_region())
    ) then
      raise exception 'You can only resolve flags in your own region.';
    end if;
  elsif v_role = 'afterschool_manager' and not public.afterschool_owned_event(v_flag.event_id) then
    raise exception 'You can only resolve flags on afterschool classes.';
  end if;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'resolution_reason', p_reason,
           'resolution_notes',  v_note
         )
   where id = p_flag_id
   returning * into v_flag;

  return v_flag;
end;
$$;

comment on function public.resolve_flag(uuid, text, text) is
  'Closes a flag with a reason code from flag_reason_label() plus optional prose. Region-scoped for regional_manager, afterschool-scoped for afterschool_manager.';

revoke execute on function public.resolve_flag(uuid, text, text) from public, anon;
grant execute on function public.resolve_flag(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_edit_attendance — same change, one layer down
-- ---------------------------------------------------------------------------
-- Body is 0065's verbatim apart from the reason handling. The role list stays
-- as it is here and is widened in section 5 below.

drop function if exists public.admin_edit_attendance(uuid, text, timestamptz, text);

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

  -- Replaces 0065's "A reason is required" check: flag_resolution_note raises
  -- on a missing or unknown code, which is the same guarantee with a list.
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
         -- The full note, not the bare code: this column is read by a human
         -- reconstructing what happened, and it is what the Attendance tab
         -- will carry once 0080 exports it.
         admin_edit_reason = v_note
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

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. admin_create_attendance — same change again
-- ---------------------------------------------------------------------------

drop function if exists public.admin_create_attendance(uuid, uuid, timestamptz, text, text);

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

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The role gate that was refusing two roles the UI offers
-- ---------------------------------------------------------------------------
-- Both functions above now accept the same six roles as MANAGER_ROLES in
-- src/lib/auth/roles.ts. Before this, 0065 enumerated four
-- ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager'),
-- while requireRole(...MANAGER_ROLES) in admin-edit-actions.ts let an
-- academic_manager and an administrator through the server action — so they
-- saw the form, filled it in, and got a raw SQL exception on submit.
--
-- Widening the SQL rather than narrowing the UI: an Academic Manager
-- reconciling a paper sign-in sheet is exactly the person YMU built this form
-- for, and neither role is region-scoped (current_sees_all_regions covers
-- them), so there is no region check to invent for them.
