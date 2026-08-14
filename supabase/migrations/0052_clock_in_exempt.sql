-- A teacher who will never clock in.
--
-- David Maden is 70-odd, has no smartphone habit and has not installed the
-- app. He has 178 classes on the calendar. Every one of them currently counts
-- as a missed clock-in: he gets a late_clock_in flag five minutes after each
-- class starts, a reminder push he will never see, and a red row on his
-- Regional Manager's dashboard forever. None of that is information — it is
-- the app being wrong about the same person 178 times.
--
-- YMU's decision (2026-08-14): treat him as present. His classes are recorded
-- automatically once they end, so his hours are right, he is absent from the
-- chasing lists, and nobody is asked to do anything.
--
-- The honest cost: if he genuinely misses a class, the app will say he was
-- there. A manager corrects it from Flags -> Edit attendance. That trade was
-- made deliberately, in preference to a daily manual entry per class.

-- ---------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists clock_in_exempt boolean not null default false;

comment on column public.profiles.clock_in_exempt is
  'This teacher is never expected to clock in; their attendance is recorded automatically by auto_attend_exempt_teachers() once each class ends. Suppresses the clock-in UI, late_clock_in flags and clock-in reminders. It does NOT mean "does not teach" — an exempt teacher still appears in schedules, reports and hours.';

-- SECURITY: profiles_update_own lets a teacher update their own row, so
-- without this a teacher could exempt themselves from ever clocking in again.
-- protect_privileged_profile_columns already guards role/region/archived_at;
-- this belongs in exactly the same list.
create or replace function public.protect_privileged_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.role is distinct from old.role
    or new.region is distinct from old.region
    or new.archived_at is distinct from old.archived_at
    or new.clock_in_exempt is distinct from old.clock_in_exempt
  )
  and auth.uid() is not null
  and coalesce(
    public.current_app_role() in ('operations_manager', 'cpo'),
    false
  ) is false
  then
    raise exception 'changing role, region, archived status, or clock-in exemption requires an operations manager or the CPO';
  end if;
  return new;
end;
$$;

-- 'exempt' joins online/offline/admin so these sessions are distinguishable
-- from a real clock-in and from a manager's manual entry — they are neither.
alter table public.attendance_sessions
  drop constraint attendance_sessions_origin_check;

alter table public.attendance_sessions
  add constraint attendance_sessions_origin_check
  check (origin in ('online', 'offline', 'admin', 'exempt'));

-- ---------------------------------------------------------------------------
-- Recording the attendance
-- ---------------------------------------------------------------------------

create or replace function public.auto_attend_exempt_teachers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.attendance_sessions (
    teacher_id, event_id, school_id,
    clock_in_at, clock_in_status,
    scheduled_start_at, scheduled_end_at,
    clock_out_at, clock_out_source,
    feedback_due_at, feedback_settled_at,
    origin
  )
  select
    t.teacher_id, ce.id, ce.school_id,
    ce.start_at, 'on_time',
    ce.start_at, ce.end_at,
    ce.end_at, 'auto_end_of_class',
    -- Null due date and an already-settled marker, deliberately. Stamping the
    -- 24-hour feedback deadline would put an exempt teacher permanently at the
    -- top of "pending feedback" with a form they were exempted from filling —
    -- swapping one impossible demand for another.
    null, now(),
    'exempt'
  from public.calendar_events ce
  cross join lateral unnest(ce.teacher_ids) as t (teacher_id)
  join public.profiles p on p.id = t.teacher_id
  where p.clock_in_exempt
    and p.archived_at is null
    and ce.status <> 'cancelled'
    and ce.all_day = false
    and ce.school_id is not null
    and ce.end_at is not null
    and ce.end_at < now()
    -- Nothing before the pilot: the initial Google sync swept in a whole
    -- previous school year, and inventing thousands of historical sessions
    -- would be far worse than the missing rows it replaces.
    and ce.start_at >= public.app_data_start()
    and not exists (
      select 1 from public.attendance_sessions a
      where a.event_id = ce.id and a.teacher_id = t.teacher_id
    );
  get diagnostics v_count = row_count;

  -- A class recorded this way is settled, so any late_clock_in flag raised for
  -- it in the five minutes after it started has nothing left to ask.
  update public.flags f
     set resolved_at = now(),
         details = coalesce(f.details, '{}'::jsonb)
           || jsonb_build_object('auto_resolved_by', 'clock_in_exempt')
    from public.attendance_sessions a
   where f.type = 'late_clock_in'
     and f.resolved_at is null
     and a.origin = 'exempt'
     and a.event_id = f.event_id
     and a.teacher_id = f.teacher_id;

  return v_count;
end;
$$;

comment on function public.auto_attend_exempt_teachers() is
  'Records attendance for teachers flagged clock_in_exempt, once each class has ended. Sessions are marked settled with no feedback deadline — an exempt teacher is exempt from the form too.';

revoke execute on function public.auto_attend_exempt_teachers() from public, anon;
grant execute on function public.auto_attend_exempt_teachers() to service_role;

-- ---------------------------------------------------------------------------
-- Stop chasing them
-- ---------------------------------------------------------------------------
-- detect_late_clockins runs five minutes after a class starts — long before
-- auto_attend_exempt_teachers can record it at the end — so without this an
-- exempt teacher collects a flag and a manager notification per class.

create or replace function public.detect_late_clockins()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_flag record;
  v_recipient uuid;
  v_count integer := 0;
begin
  for v_flag in
    insert into public.flags (type, event_id, teacher_id, school_id, details)
    select
      'late_clock_in', ce.id, t.teacher_id, ce.school_id,
      jsonb_build_object('scheduled_start_at', ce.start_at, 'summary', ce.summary)
    from public.calendar_events ce
    cross join lateral unnest(ce.teacher_ids) as t (teacher_id)
    where ce.status <> 'cancelled'
      and ce.all_day = false
      and ce.start_at is not null
      and ce.start_at + interval '5 minutes' <= now()
      and ce.start_at + interval '5 minutes' > now() - interval '30 minutes'
      and not exists (
        select 1 from public.attendance_sessions a
        where a.event_id = ce.id and a.teacher_id = t.teacher_id
      )
      and not exists (
        select 1 from public.flags f
        where f.type = 'late_clock_in' and f.event_id = ce.id and f.teacher_id = t.teacher_id
      )
      -- Never expected to clock in, so never late.
      and not exists (
        select 1 from public.profiles p
        where p.id = t.teacher_id and p.clock_in_exempt
      )
    returning id, event_id, teacher_id, school_id
  loop
    v_count := v_count + 1;
    for v_recipient in select * from public.notify_recipients_for_school(v_flag.school_id) loop
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_recipient,
        v_flag.event_id,
        'late_clock_in',
        public.manager_notification_payload(v_flag.teacher_id, v_flag.school_id, v_flag.event_id)
          || jsonb_build_object('flag_id', v_flag.id)
      );
    end loop;
  end loop;

  return v_count;
end;
$$;

-- be_there_soon and clock_in_reminder both ask the teacher to do something
-- they have been excused from. clock_out_reminder needs no change: it is
-- driven off sessions with feedback still owed, and an exempt session is born
-- settled.
create or replace function public.enqueue_reminder_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  insert into public.notification_queue (recipient_id, event_id, type, payload)
  select t.teacher_id, e.id, 'be_there_soon',
    jsonb_build_object('summary', e.summary, 'start_at', e.start_at, 'school_id', e.school_id)
  from public.calendar_events e
  cross join lateral unnest(e.teacher_ids) as t (teacher_id)
  left join public.notification_preferences p
    on p.user_id = t.teacher_id and p.type = 'be_there_soon'
  where e.status <> 'cancelled'
    and e.start_at is not null
    and now() >= e.start_at - make_interval(mins => coalesce(p.lead_minutes, 15))
    and now() < e.start_at
    and not exists (
      select 1 from public.profiles pr
      where pr.id = t.teacher_id and pr.clock_in_exempt
    )
  on conflict (recipient_id, event_id, type) where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder')
  do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  insert into public.notification_queue (recipient_id, event_id, type, payload)
  select t.teacher_id, e.id, 'clock_in_reminder',
    jsonb_build_object('summary', e.summary, 'start_at', e.start_at, 'school_id', e.school_id)
  from public.calendar_events e
  cross join lateral unnest(e.teacher_ids) as t (teacher_id)
  left join public.notification_preferences p
    on p.user_id = t.teacher_id and p.type = 'clock_in_reminder'
  where e.status <> 'cancelled'
    and e.start_at is not null
    and now() >= e.start_at + make_interval(mins => coalesce(p.lead_minutes, 0))
    and now() < e.start_at + make_interval(mins => coalesce(p.lead_minutes, 0)) + interval '30 minutes'
    and not exists (
      select 1 from public.attendance_sessions a
      where a.event_id = e.id and a.teacher_id = t.teacher_id
    )
    and not exists (
      select 1 from public.profiles pr
      where pr.id = t.teacher_id and pr.clock_in_exempt
    )
  on conflict (recipient_id, event_id, type) where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder')
  do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  insert into public.notification_queue (recipient_id, event_id, type, payload, email_status)
  select a.teacher_id, a.event_id, 'clock_out_reminder',
    jsonb_build_object(
      'session_id', a.id,
      'summary', e.summary,
      'end_at', e.end_at,
      'due_at', a.feedback_due_at,
      'school_id', a.school_id
    ),
    null
  from public.attendance_sessions a
  join public.calendar_events e on e.id = a.event_id
  left join public.notification_preferences p
    on p.user_id = a.teacher_id and p.type = 'clock_out_reminder'
  where a.feedback_settled_at is null
    and a.scheduled_end_at is not null
    and a.feedback_due_at is not null
    and now() >= a.scheduled_end_at + make_interval(mins => coalesce(p.lead_minutes, 0))
    and now() < a.feedback_due_at
  on conflict (recipient_id, event_id, type) where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder')
  do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  return v_total;
end;
$$;
