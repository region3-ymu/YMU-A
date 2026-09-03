-- ===========================================================================
-- 0095 — "teacher was absent" now means something: no pay, no on-time/late
-- ===========================================================================
--
-- region3@ymu.org, 2026-09-03, reviewing /flags:
--
--   1. Resolving a flag as "teacher was absent" has to behave like "class did
--      not happen" — no on-time/late for a class the teacher wasn't at — and
--      unlike a cancelled class, an absent teacher is NOT paid for it.
--   2. Where was the reason for the absence (sick, car trouble, ...) captured?
--      Only on the Substitutes screen, or also here?
--   3. What does "Mark resolved" without recording attendance actually do?
--
-- What the investigation found: resolve_flag() (0080) is a pure flags-table
-- annotator. Every outcome — including "They were absent" (stayed_missed) —
-- writes only to flags.details, a jsonb blob Reports and the payroll sheet
-- never read. The ONLY function that touches attendance_sessions is
-- admin_create_attendance()/admin_edit_attendance() (0087), reached from a
-- separate "Record attendance" button that shares the wrong reason list
-- (FLAG_REASONS, "why was the clock-in late") — and it only special-cases
-- reason='class_not_held'. Picking reason='teacher_absent' there falls
-- through to the default on_time/late path: a PAID, "class taught" record
-- for someone who did not teach it. So today, answer to #3 is: nothing about
-- pay ever changes from "Mark resolved", regardless of what is picked — and
-- the one place that DOES touch pay gets "teacher was absent" backwards.
--
-- The fix is a new status, distinct from not_held's "no fault, still paid":
--
--   not_held   no lesson delivered, nobody's fault  -> PAID,   not taught
--   absent     no lesson delivered, teacher's fault  -> UNPAID, not taught
--
-- resolve_flag()'s stayed_missed AND substitute_covered outcomes (confirmed
-- with YMU, 2026-09-03 — a covered class still means the ORIGINAL teacher
-- gets an absent/unpaid record; the substitute is paid separately via their
-- own clock-in once the calendar event's attendee is updated) now create or
-- update the attendance_sessions row for real, carrying the absence reason,
-- excused flag, and notice channel that used to be stranded in flags.details.
-- admin_create_attendance/admin_edit_attendance get the same reason -> status
-- override class_not_held already had, closing the "Record attendance" gap.
--
-- Excused absences are still unpaid (confirmed with YMU) — "excused" answers
-- "does this count against them for HR/pattern purposes", not "do we owe
-- them money for a class they did not teach".
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The new status, and the detail that used to live only in flags.details
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions
  drop constraint if exists attendance_clock_in_status_check;

alter table public.attendance_sessions
  add constraint attendance_clock_in_status_check
  check (clock_in_status in ('on_time', 'late', 'not_held', 'absent'));

comment on column public.attendance_sessions.clock_in_status is
  'on_time / late describe a clock-in. not_held means the class did not happen (nobody''s fault): it still pays but is not a class taught. absent means the assigned teacher did not show for a class that DID happen: not paid, not taught, and not on-time-or-late either.';

alter table public.attendance_sessions
  add column if not exists absence_reason text,
  add column if not exists absence_excused boolean,
  add column if not exists absence_notified_channel text;

alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_absence_reason_known;
alter table public.attendance_sessions
  add constraint attendance_sessions_absence_reason_known
  check (absence_reason is null or absence_reason in (
    'sick', 'family_emergency', 'personal', 'second_job', 'transport',
    'training', 'school_request', 'no_reason_given', 'other'
  ));

alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_notified_channel_known;
alter table public.attendance_sessions
  add constraint attendance_sessions_notified_channel_known
  check (absence_notified_channel is null or absence_notified_channel in (
    'called', 'texted', 'emailed', 'told_colleague', 'none'
  ));

comment on column public.attendance_sessions.absence_reason is
  'Why the teacher was away, when clock_in_status = absent. Same domain as substitutions.reason (absence_reason_label()) — one question asked from three places now, not two.';
comment on column public.attendance_sessions.absence_excused is
  'Whether the absence is excused. Affects nothing about pay (an absence is unpaid either way) — it is the HR/pattern-tracking signal 0080 introduced this column to stop losing at resolution time.';
comment on column public.attendance_sessions.absence_notified_channel is
  'How the teacher let anyone know they would be away, or ''none''. Only meaningful alongside absence_reason.';

-- ---------------------------------------------------------------------------
-- 2. Reports: absent is out of hoursWorked (unlike not_held), same shape
-- ---------------------------------------------------------------------------

create or replace view public.attendance_period_rows
with (security_invoker = true) as
  select
    ce.id as event_id,
    t.teacher_id,
    ce.school_id,
    s.region as school_region,
    ce.summary,
    ce.start_at,
    ce.end_at,
    asn.id as session_id,
    asn.clock_in_status,
    asn.clock_in_at,
    asn.clock_out_at,
    asn.origin,
    case
      when asn.id is not null then asn.clock_in_status
      when ce.end_at is not null and ce.end_at < now() then 'missed'
      else 'upcoming'
    end as attendance_status,
    case
      when asn.id is not null and asn.clock_in_status <> 'absent'
       and ce.start_at is not null and ce.end_at is not null
      then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
      else null::numeric
    end as hours_worked
  from public.calendar_events ce
  join lateral unnest(ce.teacher_ids) as t(teacher_id) on true
  join public.schools s on s.id = ce.school_id
  left join public.attendance_sessions asn
    on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
  where ce.status <> 'cancelled'
    and ce.school_id is not null
    and ce.all_day = false
    and ce.start_at >= public.app_data_start()
    -- The demo site never counts as real work.
    and s.name <> 'YMU Demo Site'
    and (
      t.teacher_id = auth.uid()
      or public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and s.region = public.current_app_region()
      )
    );

comment on view public.attendance_period_rows is
  'One row per (class, teacher) with its attendance status and scheduled hours, bounded below by app_data_start() and excluding YMU Demo Site. hours_worked excludes clock_in_status=absent (unpaid) but not not_held (still paid). security_invoker — the WHERE clause is the authorization.';

-- ---------------------------------------------------------------------------
-- 3. resolve_flag() — stayed_missed/substitute_covered now write a real,
--    unpaid attendance_sessions row instead of only flags.details
-- ---------------------------------------------------------------------------
-- Same signature as 0080's — a body-only change, no drop needed.

create or replace function public.resolve_flag(
  p_flag_id             uuid,
  p_reason              text,
  p_notes               text default null,
  p_outcome             text default null,
  p_absence_reason      text default null,
  p_notified_in_advance boolean default null,
  p_notified_channel    text default null,
  p_excused             boolean default null,
  p_substitution_id     uuid default null
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

  -- The outcome is optional so the other three flag types, and the everyday
  -- "they forgot" case, stay a two-field form. Everything below only applies
  -- once a manager has said what happened.
  if p_outcome is not null then
    if public.flag_outcome_label(p_outcome) is null then
      raise exception 'Choose what happened. "%" is not one of the options.', p_outcome;
    end if;
    v_detail := v_detail || jsonb_build_object('resolution_outcome', p_outcome);

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
      -- The one pair that can contradict itself. "They gave notice" and "no
      -- notice at all" cannot both be true, and a row saying both is worse
      -- than a row saying neither.
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
      -- The whole point of a link over a typed name: it can be wrong, and
      -- being wrong can be detected.
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

    -- The part that used to be missing: an absence, covered or not, is a real
    -- attendance record now — unpaid, not taught, no on-time/late question,
    -- same as class_not_held except for the paid half. The substitute (if
    -- any) is paid separately via their own clock-in; this row is only ever
    -- about the teacher who was scheduled and did not teach.
    if p_outcome in ('stayed_missed', 'substitute_covered') then
      if v_flag.event_id is null or v_flag.teacher_id is null then
        raise exception 'This flag is not linked to a class and teacher, so an outcome does not apply.';
      end if;

      select * into v_event from public.calendar_events where id = v_flag.event_id;
      if not found then
        raise exception 'Class not found.';
      end if;

      select id into v_existing_session_id
        from public.attendance_sessions
       where event_id = v_flag.event_id and teacher_id = v_flag.teacher_id;

      if v_existing_session_id is not null then
        update public.attendance_sessions
           set clock_in_status          = 'absent',
               absence_reason           = p_absence_reason,
               absence_excused          = p_excused,
               absence_notified_channel = p_notified_channel,
               admin_edited_at          = now(),
               admin_edited_by          = v_uid,
               admin_edit_reason        = v_note,
               feedback_due_at          = null,
               feedback_settled_at      = coalesce(feedback_settled_at, now())
         where id = v_existing_session_id;
      else
        insert into public.attendance_sessions (
          teacher_id, event_id, school_id, clock_in_at, clock_in_status,
          absence_reason, absence_excused, absence_notified_channel,
          scheduled_start_at, scheduled_end_at, feedback_due_at, feedback_settled_at,
          clock_out_at, clock_out_source,
          origin, admin_edited_at, admin_edited_by, admin_edit_reason
        ) values (
          v_flag.teacher_id, v_flag.event_id, v_event.school_id, v_event.start_at, 'absent',
          p_absence_reason, p_excused, p_notified_channel,
          v_event.start_at, v_event.end_at, null, now(),
          case when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at end,
          case when v_event.end_at is not null and v_event.end_at <= now() then 'admin' end,
          'admin', now(), v_uid, v_note
        );
      end if;
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

comment on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) is
  'Closes a flag with a reason code and, when the manager says what actually happened, the structured detail that outcome implies. stayed_missed and substitute_covered ALSO create or update a real attendance_sessions row (clock_in_status=absent: unpaid, not taught, no on-time/late), carrying the absence reason/excused/notice fields — the substitute (if any) is paid separately via their own clock-in.';

revoke execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) from public, anon;
grant execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. admin_create_attendance / admin_edit_attendance — teacher_absent forces
--    the same override class_not_held already had
-- ---------------------------------------------------------------------------
-- Bodies are 0087's verbatim apart from the reason -> status override.

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
  -- 'not_held'/'absent' are accepted from the caller too, so the UI can send
  -- either directly.
  if p_clock_in_status not in ('on_time', 'late', 'not_held', 'absent') then
    raise exception 'clock_in_status must be on_time, late, not_held or absent.';
  end if;

  v_note := public.flag_resolution_note('Recorded by manager: ', p_reason, p_reason_notes);

  -- The reason wins. There is no such thing as arriving on time to a class
  -- that did not happen, or to one the teacher was not at.
  v_status := case
    when p_reason = 'class_not_held' then 'not_held'
    when p_reason = 'teacher_absent' then 'absent'
    else p_clock_in_status
  end;

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
  'Records attendance a teacher never clocked in for. class_not_held forces status not_held (paid, not taught); teacher_absent forces status absent (unpaid, not taught) — both owe no feedback. The deadline is otherwise floored at now() + 24 hours so a back-dated entry cannot be born overdue.';

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

  update public.attendance_sessions
     set clock_in_status   = coalesce(v_forced_status, p_clock_in_status, clock_in_status),
         clock_in_at       = coalesce(p_clock_in_at, clock_in_at),
         admin_edited_at   = now(),
         admin_edited_by   = v_uid,
         admin_edit_reason = v_note,
         -- 0087/0095: only class_not_held and teacher_absent touch the
         -- feedback demand here.
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
  'Corrects an existing attendance session. class_not_held forces status not_held (paid, not taught); teacher_absent forces status absent (unpaid, not taught) — both clear any feedback still owed. No other reason touches either.';

revoke execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.admin_edit_attendance(uuid, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The payroll sheet: absent is unpaid there too, and carries why
-- ---------------------------------------------------------------------------
-- Shape change (3 columns added), so this one needs the drop.

drop function if exists public.attendance_for_sheet(timestamptz, timestamptz);

create or replace function public.attendance_for_sheet(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  event_id uuid,
  session_id uuid,
  class_date date,
  class_time text,
  class_title text,
  program text,
  is_afterschool text,
  teacher_name text,
  teacher_email text,
  school_name text,
  region text,
  regional_manager text,
  attendance_status text,
  clock_in_at timestamptz,
  clock_in_minutes_late integer,
  clock_out_at timestamptz,
  clock_out_source text,
  hours_worked numeric,
  clock_in_origin text,
  distance_m integer,
  feedback_submitted text,
  absence_reason text,
  absence_excused text,
  absence_notified_channel text,
  edited_by text,
  edited_at timestamptz,
  edit_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      coalesce(
        p_from,
        (select (y.start_date - interval '1 month')::timestamptz
           from public.school_years y
          where not y.archived
          order by y.start_date desc
          limit 1)
      ) as lo,
      coalesce(
        p_to,
        (select (y.end_date + interval '1 day')::timestamptz
           from public.school_years y
          where not y.archived
          order by y.start_date desc
          limit 1)
      ) as hi
  )
  select
    ce.id,
    asn.id,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    ce.summary,
    (select pr.name from public.programs pr
      where pr.active
        and exists (
          select 1 from unnest(pr.match_patterns) mp
           where position(mp in lower(coalesce(ce.summary, ''))) > 0
        )
      order by pr.sort_order
      limit 1),
    case when ce.is_afterschool then 'Yes' else 'No' end,
    p.full_name,
    u.email::text,
    s.name,
    s.region::text,
    (select rm.full_name from public.profiles rm
      where rm.role = 'regional_manager' and rm.region = s.region and rm.archived_at is null
      order by rm.created_at limit 1),
    case
      when asn.id is not null then asn.clock_in_status
      when ce.end_at is not null and ce.end_at < now() then 'missed'
      else 'upcoming'
    end,
    asn.clock_in_at,
    case
      when asn.clock_in_at is not null and ce.start_at is not null and asn.clock_in_at > ce.start_at
      then (extract(epoch from (asn.clock_in_at - ce.start_at)) / 60)::integer
    end,
    asn.clock_out_at,
    asn.clock_out_source,
    -- Unchanged for on_time/late/not_held, and still the SCHEDULED length
    -- rather than clock-out minus clock-in. 0095: absent is unpaid, so it is
    -- excluded here too — the same rule attendance_period_rows applies for
    -- Reports, so the sheet and the app can never disagree about a paycheck.
    case
      when asn.id is not null and asn.clock_in_status <> 'absent'
       and ce.start_at is not null and ce.end_at is not null
      then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
    end,
    asn.origin,
    asn.clock_in_distance_m::integer,
    case when asn.feedback_settled_at is not null then 'Yes'
         when asn.id is not null then 'No'
    end,
    public.absence_reason_label(asn.absence_reason),
    case asn.absence_excused when true then 'Yes' when false then 'No' end,
    public.notice_channel_label(asn.absence_notified_channel),
    editor.full_name,
    asn.admin_edited_at,
    asn.admin_edit_reason
  from public.calendar_events ce
  cross join bounds b
  join lateral unnest(ce.teacher_ids) as t (teacher_id) on true
  join public.schools s on s.id = ce.school_id
  join public.profiles p on p.id = t.teacher_id
  left join auth.users u on u.id = t.teacher_id
  left join public.attendance_sessions asn
    on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
  left join public.profiles editor on editor.id = asn.admin_edited_by
  where ce.status <> 'cancelled'
    and ce.school_id is not null
    and ce.all_day = false
    and (b.lo is null or ce.start_at >= b.lo)
    and (b.hi is null or ce.start_at <  b.hi)
  order by ce.start_at, s.name, p.full_name;
$$;

comment on function public.attendance_for_sheet(timestamptz, timestamptz) is
  'One row per teacher per scheduled class, bounded by the current school_years row unless told otherwise. Carries the manager edit trail and the afterschool flag. NOTE: hours_worked is the scheduled class length, not time actually clocked, and is null for clock_in_status=absent (unpaid).';

revoke execute on function public.attendance_for_sheet(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.attendance_for_sheet(timestamptz, timestamptz) to service_role;
