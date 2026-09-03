-- ===========================================================================
-- 0099 — absent/not_held must never leave a session "open"
-- ===========================================================================
--
-- Live incident, 2026-09-03: Mark Pollock was swapped into Madison's classes
-- (via a direct Google Calendar edit, not through /substitutes) after James
-- Perez didn't show, at the same time as his own Miami Central class got
-- cancelled by the school. Resolving Madison's Drumline I flag as
-- "attendance_corrected" (he was there, on time) created a session with
-- clock_out_at left null — correct in isolation, since the class had not
-- ended yet at the moment of resolution, same as a real online clock-in
-- would be. But nothing ever comes back to close a session recorded this
-- way except the "class actually ends" sweep, and meanwhile
-- attendance_one_open_session_per_teacher (one open session PER TEACHER,
-- not per class) blocked recording anything else for him — his Central flag,
-- and his second Madison class — until a manager manually closed it by hand.
--
-- The bug: this is fine for attendance_corrected (a real, ongoing class) but
-- wrong for absent/not_held. Nobody is "still in" a class that did not
-- happen or that they were not at — there is nothing to wait for the class
-- to "finish" before closing. Both admin_create_attendance's insert and
-- resolve_flag's insert/update paths left these open exactly like a real
-- clock-in when the class had not yet ended, which is how one absent/
-- not_held resolution could strand a teacher's NEXT class, or a same-teacher
-- correction on a DIFFERENT class, behind a phantom open session.
--
-- Fix, in all three functions that write these two statuses: absent/
-- not_held sessions close immediately (clock_out_at = the class's scheduled
-- end, or now() if the class has none), whether inserting new or updating an
-- existing session created by an on_time/late clock-in that turned out to
-- be wrong. attendance_corrected/on_time/late are untouched — those DO stay
-- open until the class genuinely ends, same as before.
-- ===========================================================================

create or replace function public.resolve_flag(
  p_flag_id             uuid,
  p_reason              text,
  p_notes               text default null,
  p_outcome             text default null,
  p_absence_reason      text default null,
  p_notified_in_advance boolean default null,
  p_notified_channel    text default null,
  p_excused             boolean default null,
  p_substitution_id     uuid default null,
  p_clock_in_at         timestamptz default null,
  p_clock_in_status     text default null
)
returns public.flags
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_role   public.app_role := public.current_app_role();
  v_flag   public.flags%rowtype;
  v_note   text;
  v_detail jsonb := '{}'::jsonb;
  v_sub    public.substitutions;
  v_event  public.calendar_events;
  v_existing_session_id uuid;
  v_new_status text;
  v_no_feedback boolean;
  v_due timestamptz;
  v_clock_in_at timestamptz;
  v_clock_out timestamptz;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if not (v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions()) then
    raise exception 'Only managers can resolve flags.';
  end if;

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

  if p_outcome is not null then
    if public.flag_outcome_label(p_outcome) is null then
      raise exception 'Choose what happened. "%" is not one of the options.', p_outcome;
    end if;
    v_detail := v_detail || jsonb_build_object('resolution_outcome', p_outcome);

    if p_outcome = 'attendance_corrected' then
      if p_clock_in_status not in ('on_time', 'late') then
        raise exception 'Record whether they were on time or late.';
      end if;
    elsif p_clock_in_at is not null or p_clock_in_status is not null then
      raise exception 'A clock-in time only applies to "They were here".';
    end if;

    if p_outcome in ('stayed_missed', 'substitute_covered') then
      if public.absence_reason_label(p_absence_reason) is null then
        raise exception 'Choose why the teacher was away.';
      end if;
      if p_absence_reason = 'other' and nullif(btrim(coalesce(p_notes, '')), '') is null then
        raise exception 'Choosing "Other" for the absence means writing what happened.';
      end if;
      v_detail := v_detail || jsonb_build_object('absence_reason', p_absence_reason);
    elsif p_absence_reason is not null then
      raise exception 'An absence reason does not apply when the teacher was here.';
    end if;

    if p_outcome = 'stayed_missed' then
      if p_notified_in_advance is null then
        raise exception 'Record whether the teacher let anyone know in advance.';
      end if;
      if public.notice_channel_label(p_notified_channel) is null then
        raise exception 'Record how the teacher let anyone know — "No notice at all" is an answer.';
      end if;
      if p_notified_in_advance and p_notified_channel = 'none' then
        raise exception 'They either gave notice or they did not — pick a channel, or say they gave none.';
      end if;
      if not p_notified_in_advance and p_notified_channel <> 'none' then
        raise exception 'A channel means they did give notice.';
      end if;
      if p_excused is null then
        raise exception 'Record whether this absence is excused.';
      end if;
      v_detail := v_detail || jsonb_build_object(
        'notified_in_advance', p_notified_in_advance,
        'notified_channel',    p_notified_channel,
        'excused',             p_excused
      );
    elsif p_notified_in_advance is not null or p_notified_channel is not null or p_excused is not null then
      raise exception 'Notice and excusal only apply when the teacher was absent.';
    end if;

    if p_outcome = 'substitute_covered' then
      if p_substitution_id is null then
        raise exception 'Pick the substitution that covered this class, or record one first.';
      end if;
      select * into v_sub from public.substitutions where id = p_substitution_id;
      if not found then
        raise exception 'Substitution not found.';
      end if;
      if v_sub.event_id is distinct from v_flag.event_id then
        raise exception 'That substitution is for a different class.';
      end if;
      if v_sub.absent_teacher_id is distinct from v_flag.teacher_id then
        raise exception 'That substitution covers a different teacher.';
      end if;
      if v_sub.status <> 'confirmed' then
        raise exception 'That substitution was cancelled.';
      end if;
      v_detail := v_detail || jsonb_build_object('substitution_id', p_substitution_id);
    elsif p_substitution_id is not null then
      raise exception 'A substitution only applies when a substitute covered the class.';
    end if;

    v_new_status := case
      when p_outcome in ('stayed_missed', 'substitute_covered') then 'absent'
      when p_outcome = 'class_not_held' then 'not_held'
      when p_outcome = 'attendance_corrected' then p_clock_in_status
    end;
    v_no_feedback := v_new_status in ('absent', 'not_held');
    v_clock_in_at := case when p_outcome = 'attendance_corrected' then p_clock_in_at end;

    if v_flag.event_id is null or v_flag.teacher_id is null then
      raise exception 'This flag is not linked to a class and teacher, so an outcome does not apply.';
    end if;

    select * into v_event from public.calendar_events where id = v_flag.event_id;
    if not found then
      raise exception 'Class not found.';
    end if;

    -- absent/not_held are never "in progress" — close them out immediately
    -- rather than waiting for a class-end sweep that only makes sense for a
    -- real clock-in. Falls back to now() on the rare event with no end_at.
    v_clock_out := case
      when v_no_feedback then coalesce(v_event.end_at, now())
      when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at
    end;
    v_due := case
      when v_no_feedback then null
      when v_event.end_at is null then null
      else greatest(v_event.end_at + interval '24 hours', now() + interval '24 hours')
    end;

    select id into v_existing_session_id
      from public.attendance_sessions
     where event_id = v_flag.event_id and teacher_id = v_flag.teacher_id;

    if v_existing_session_id is not null then
      update public.attendance_sessions
         set clock_in_status          = v_new_status,
             clock_in_at              = coalesce(v_clock_in_at, clock_in_at),
             absence_reason           = p_absence_reason,
             absence_excused          = p_excused,
             absence_notified_channel = p_notified_channel,
             admin_edited_at          = now(),
             admin_edited_by          = v_uid,
             admin_edit_reason        = v_note,
             -- Force-close a session this outcome now says was never real
             -- attendance, even if it was left open by an earlier (possibly
             -- mistaken) on_time/late resolution. Leaves a genuinely open
             -- real clock-in alone otherwise.
             clock_out_at             = case when v_no_feedback then coalesce(clock_out_at, v_event.end_at, now()) else clock_out_at end,
             clock_out_source         = case when v_no_feedback and clock_out_at is null then 'admin' else clock_out_source end,
             feedback_due_at          = case when v_no_feedback then null else feedback_due_at end,
             feedback_settled_at      = case
                                          when v_no_feedback then coalesce(feedback_settled_at, now())
                                          else feedback_settled_at
                                        end
       where id = v_existing_session_id;
    else
      insert into public.attendance_sessions (
        teacher_id, event_id, school_id, clock_in_at, clock_in_status,
        absence_reason, absence_excused, absence_notified_channel,
        scheduled_start_at, scheduled_end_at, feedback_due_at, feedback_settled_at,
        clock_out_at, clock_out_source,
        origin, admin_edited_at, admin_edited_by, admin_edit_reason
      ) values (
        v_flag.teacher_id, v_flag.event_id, v_event.school_id,
        coalesce(v_clock_in_at, v_event.start_at), v_new_status,
        p_absence_reason, p_excused, p_notified_channel,
        v_event.start_at, v_event.end_at, v_due,
        case when v_no_feedback then now() end,
        v_clock_out,
        case when v_clock_out is null then null else 'admin' end,
        'admin', now(), v_uid, v_note
      );
    end if;
  end if;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb)
           || jsonb_build_object(
                'resolution_reason', p_reason,
                'resolution_notes',  v_note
              )
           || v_detail
   where id = p_flag_id
   returning * into v_flag;

  return v_flag;
end;
$$;

comment on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid, timestamptz, text) is
  'Closes a flag with a reason code and, when the manager says what actually happened, the structured detail that outcome implies AND the matching attendance_sessions write: stayed_missed/substitute_covered -> absent (unpaid), class_not_held -> not_held (paid, not taught), attendance_corrected -> on_time/late (paid, feedback owed). absent/not_held sessions are always closed immediately (0099) — they are never "in progress", so they must never leave the teacher''s one-open-session slot occupied.';

-- ---------------------------------------------------------------------------
-- admin_create_attendance / admin_edit_attendance — same fix
-- ---------------------------------------------------------------------------

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
  v_no_feedback boolean := p_reason in ('class_not_held', 'teacher_absent');
  v_due timestamptz;
  v_status text;
begin
  if v_uid is null or v_role not in (
    'regional_manager', 'afterschool_manager', 'academic_manager',
    'operations_manager', 'administrator', 'cpo'
  ) then
    raise exception 'Only a manager can record attendance.';
  end if;
  if p_clock_in_status not in ('on_time', 'late', 'not_held', 'absent') then
    raise exception 'clock_in_status must be on_time, late, not_held or absent.';
  end if;

  v_note := public.flag_resolution_note('Recorded by manager: ', p_reason, p_reason_notes);

  v_status := case
    when p_reason = 'class_not_held' then 'not_held'
    when p_reason = 'teacher_absent' then 'absent'
    else p_clock_in_status
  end;
  -- The status wins over the reason if they ever disagree (e.g. a future
  -- caller passing clock_in_status='absent' directly without reason=
  -- teacher_absent) — either way, absent/not_held never owes feedback.
  v_no_feedback := v_no_feedback or v_status in ('absent', 'not_held');

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

  -- absent/not_held are never "in progress" — close immediately rather than
  -- only when the class has already ended (0099).
  v_clock_out := case
    when v_no_feedback then coalesce(v_event.end_at, now())
    when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at
    else null
  end;

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
  'Records attendance a teacher never clocked in for. class_not_held forces status not_held (paid, not taught); teacher_absent forces status absent (unpaid, not taught) — both owe no feedback and close out immediately (0099), never left "in progress" like a real on_time/late clock-in. The deadline is otherwise floored at now() + 24 hours so a back-dated entry cannot be born overdue.';

revoke execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) from public, anon;
grant execute on function public.admin_create_attendance(uuid, uuid, timestamptz, text, text, text) to authenticated;

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
  v_no_feedback boolean := p_reason in ('class_not_held', 'teacher_absent');
  v_forced_status text := case
    when p_reason = 'class_not_held' then 'not_held'
    when p_reason = 'teacher_absent' then 'absent'
    else null
  end;
  v_event public.calendar_events;
begin
  if v_uid is null or v_role not in (
    'regional_manager', 'afterschool_manager', 'academic_manager',
    'operations_manager', 'administrator', 'cpo'
  ) then
    raise exception 'Only a manager can edit attendance.';
  end if;
  if p_clock_in_status is not null and p_clock_in_status not in ('on_time', 'late', 'not_held', 'absent') then
    raise exception 'clock_in_status must be on_time, late, not_held or absent.';
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

  -- The status this edit is about to produce, from whichever source wins
  -- (the reason forces it; otherwise the caller's own status).
  v_no_feedback := v_no_feedback or coalesce(v_forced_status, p_clock_in_status) in ('absent', 'not_held');

  if v_no_feedback then
    select * into v_event from public.calendar_events where id = v_row.event_id;
  end if;

  update public.attendance_sessions
     set clock_in_status   = case
                               when v_no_feedback then coalesce(v_forced_status, p_clock_in_status, clock_in_status)
                               else coalesce(p_clock_in_status, clock_in_status)
                             end,
         clock_in_at       = coalesce(p_clock_in_at, clock_in_at),
         admin_edited_at   = now(),
         admin_edited_by   = v_uid,
         admin_edit_reason = v_note,
         -- absent/not_held are never "in progress" — close out immediately
         -- (0099), same as admin_create_attendance/resolve_flag. An edit
         -- that keeps on_time/late leaves clock_out_at exactly as it was.
         clock_out_at        = case
                                 when v_no_feedback then coalesce(clock_out_at, v_event.end_at, now())
                                 else clock_out_at
                               end,
         clock_out_source    = case
                                 when v_no_feedback and clock_out_at is null then 'admin'
                                 else clock_out_source
                               end,
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
  'Corrects an existing attendance session. class_not_held forces status not_held (paid, not taught); teacher_absent forces status absent (unpaid, not taught) — both clear any feedback still owed AND close the session out immediately (0099) if it was left open, since neither is ever "in progress". No other reason touches either.';

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) to authenticated;
