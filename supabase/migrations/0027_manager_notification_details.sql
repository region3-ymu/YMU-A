-- Manager notifications carry the details instead of pointing at them.
--
-- Today an RM's push for a missed clock-in reads, in full: "A teacher hasn't
-- clocked in for a scheduled class." No teacher, no school, no time. The
-- manager has to stop, open the app, and find /flags to learn anything at all
-- — at which point the notification did nothing except interrupt them.
--
-- The data was always there. notification_queue.payload has carried
-- teacher_id/school_id/flag_id since 0012; notificationCopy() in
-- dispatch-logic.ts just never read past payload.summary, and the ids are
-- useless to it anyway without a join.
--
-- Enriched at ENQUEUE time rather than looked up at dispatch. Three reasons:
-- notificationCopy() stays a pure function of the row, which is what makes it
-- unit-testable; the dispatcher stays free of an N+1 query per notification;
-- and the payload becomes a record of what was true when the thing happened,
-- which is what you want when reading an old queue row.
--
-- Privacy: these types are only ever queued for the school's Regional Manager
-- (or the OM/CPO fallback) via notify_recipients_for_school. Including the
-- teacher's phone matches the PRD's ticket metadata side-panel and the NFR
-- that contact details are visible to assigned agents and Admins.


-- ---------------------------------------------------------------------------
-- The shared enrichment. One LEFT JOIN per entity so a missing school or a
-- deleted event degrades to fewer keys rather than no notification at all —
-- an unmatched-school class is exactly the kind of thing a manager most needs
-- to hear about.
--
-- jsonb_strip_nulls means the TypeScript side can test for presence instead of
-- carrying null-checks for every field.
-- ---------------------------------------------------------------------------

create or replace function public.manager_notification_payload(
  p_teacher_id uuid,
  p_school_id uuid,
  p_event_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'teacher_id', p_teacher_id,
    'teacher_name', p.full_name,
    'teacher_phone', p.phone,
    'school_id', p_school_id,
    'school_name', s.name,
    'school_region', s.region::text,
    'event_id', p_event_id,
    'summary', ce.summary,
    'start_at', ce.start_at
  ))
  from (select 1) as anchor
  left join public.profiles p on p.id = p_teacher_id
  left join public.schools s on s.id = p_school_id
  left join public.calendar_events ce on ce.id = p_event_id;
$$;

comment on function public.manager_notification_payload(uuid, uuid, uuid) is
  'Builds the notification_queue.payload for a manager-facing alert: teacher name and phone, school name and region, class summary and start. security definer because the detectors run as service_role but the shape must be identical whoever calls it.';

revoke execute on function public.manager_notification_payload(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.manager_notification_payload(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 1. late_clock_in — detect_late_clockins()
--    Body unchanged from 0012 except the payload. The flag row already
--    recorded summary/scheduled_start_at; only the notification was blind.
-- ---------------------------------------------------------------------------

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

revoke execute on function public.detect_late_clockins() from public, anon, authenticated;
grant execute on function public.detect_late_clockins() to service_role;

-- ---------------------------------------------------------------------------
-- 2. feedback_stuck — detect_stuck_feedback_sessions()
--    Carries feedback_due_at too: "overdue by how long" is the first thing a
--    manager asks, and 0026 made that a real field rather than a guess.
-- ---------------------------------------------------------------------------

create or replace function public.detect_stuck_feedback_sessions(p_stuck_after_hours integer default 0)
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
    insert into public.flags (type, session_id, event_id, teacher_id, school_id, details)
    select
      'feedback_stuck', a.id, a.event_id, a.teacher_id, a.school_id,
      jsonb_build_object(
        'clock_in_at', a.clock_in_at,
        'scheduled_start_at', a.scheduled_start_at,
        'feedback_due_at', a.feedback_due_at
      )
    from public.attendance_sessions a
    where a.feedback_settled_at is null
      and a.feedback_due_at is not null
      and a.feedback_due_at + make_interval(hours => p_stuck_after_hours) < now()
      and not exists (
        select 1 from public.flags f
        where f.type = 'feedback_stuck' and f.session_id = a.id
      )
    returning id, session_id, event_id, teacher_id, school_id
  loop
    v_count := v_count + 1;
    for v_recipient in select * from public.notify_recipients_for_school(v_flag.school_id) loop
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_recipient,
        v_flag.event_id,
        'feedback_stuck',
        public.manager_notification_payload(v_flag.teacher_id, v_flag.school_id, v_flag.event_id)
          || jsonb_build_object(
               'flag_id', v_flag.id,
               'session_id', v_flag.session_id,
               'feedback_due_at', (
                 select feedback_due_at from public.attendance_sessions where id = v_flag.session_id
               )
             )
      );
    end loop;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.detect_stuck_feedback_sessions(integer) from public, anon, authenticated;
grant execute on function public.detect_stuck_feedback_sessions(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. gps_out_of_fence — record_gps_check()
--    Called by the teacher, not service_role, which is why the enrichment
--    helper is security definer: a teacher cannot read another profile's
--    phone, but this payload is never delivered to a teacher.
-- ---------------------------------------------------------------------------

create or replace function public.record_gps_check(
  p_check_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns public.gps_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_check public.gps_checks;
  v_session public.attendance_sessions;
  v_school public.schools;
  v_distance double precision;
  v_status text;
  v_recipient uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_check from public.gps_checks where id = p_check_id;
  if not found or v_check.teacher_id <> v_uid then
    raise exception 'That GPS check could not be found.';
  end if;
  if v_check.status <> 'pending' then
    return v_check; -- already recorded or closed out; idempotent.
  end if;

  select * into v_session from public.attendance_sessions where id = v_check.session_id;
  if not found then
    raise exception 'That GPS check has no session.';
  end if;

  select * into v_school from public.schools where id = v_session.school_id;
  if v_school.lat is null or v_school.lng is null then
    update public.gps_checks
       set status = 'unverifiable', sampled_at = now(), lat = p_lat, lng = p_lng, accuracy_m = p_accuracy_m
     where id = p_check_id
     returning * into v_check;
    return v_check;
  end if;

  v_distance := public.haversine_meters(p_lat, p_lng, v_school.lat, v_school.lng);
  v_status := case when v_distance <= v_school.geofence_radius_m then 'verified' else 'out_of_fence' end;

  update public.gps_checks
     set status = v_status, sampled_at = now(), lat = p_lat, lng = p_lng,
         accuracy_m = p_accuracy_m, distance_m = v_distance
   where id = p_check_id
   returning * into v_check;

  if v_status = 'out_of_fence' then
    insert into public.flags (type, session_id, event_id, teacher_id, school_id, gps_check_id, details)
    values (
      'gps_out_of_fence', v_session.id, v_session.event_id, v_uid, v_session.school_id, v_check.id,
      jsonb_build_object(
        'distance_m', v_distance,
        'geofence_radius_m', v_school.geofence_radius_m,
        'due_at', v_check.due_at
      )
    );

    for v_recipient in select * from public.notify_recipients_for_school(v_session.school_id) loop
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_recipient,
        v_session.event_id,
        'gps_out_of_fence',
        public.manager_notification_payload(v_uid, v_session.school_id, v_session.event_id)
          || jsonb_build_object(
               'session_id', v_session.id,
               'distance_m', round(v_distance)::integer,
               'geofence_radius_m', v_school.geofence_radius_m
             )
      );
    end loop;
  end if;

  return v_check;
end;
$$;

revoke execute on function public.record_gps_check(uuid, double precision, double precision, double precision) from public, anon;
grant execute on function public.record_gps_check(uuid, double precision, double precision, double precision) to authenticated;
