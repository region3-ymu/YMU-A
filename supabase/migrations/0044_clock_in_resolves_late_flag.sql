-- Close a late-clock-in flag when the teacher actually turns up.
--
-- detect_late_clockins() raises a `late_clock_in` flag 5 minutes after a class
-- starts if no attendance session exists yet. Nothing ever closed it again, so
-- the dashboard's "Late clock-ins" card and the /flags page accumulated two
-- different populations under one heading: teachers who walked in a couple of
-- minutes later, and teachers who never came at all. On 2026-08-14, 9 of the
-- 20 open flags belonged to teachers who had since clocked in — Renzo Vargas
-- was flagged at 17:45 and clocked in at 17:56, and stayed on the list.
--
-- Arriving inside 15 minutes of the start now closes the flag by itself. Later
-- than that stays open for a manager to look at, which is the whole point of
-- the flag. Either way the lateness itself is still recorded permanently on
-- attendance_sessions.clock_in_status, so nothing is lost by closing the flag.
--
-- resolved_by stays null on purpose: `resolve_flag()` sets it to the manager
-- who cleared the flag, and a teacher clocking in is not that. The details
-- blob carries what happened instead.

create or replace function public.clock_in(
  p_event_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null,
  p_client_key uuid default null,
  p_grace_minutes integer default 5,
  p_origin text default 'online',
  p_clock_in_at timestamptz default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event public.calendar_events%rowtype;
  v_school public.schools%rowtype;
  v_distance double precision;
  v_status text;
  v_origin text := case when p_origin = 'offline' then 'offline' else 'online' end;
  v_clock_in_at timestamptz := now();
  v_overdue integer;
  v_row public.attendance_sessions;
  -- How late someone can be and still have the flag close itself.
  -- Deliberately wider than p_grace_minutes (which decides on_time vs late):
  -- this is "close enough that a manager does not need to chase it", not
  -- "on time".
  v_flag_grace constant interval := interval '15 minutes';
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock in.';
  end if;

  if exists (
    select 1 from public.profiles where id = v_uid and archived_at is not null
  ) then
    raise exception 'This account has been archived and can no longer clock in.';
  end if;

  if p_client_key is not null then
    select * into v_row
    from public.attendance_sessions
    where client_key = p_client_key and teacher_id = v_uid;
    if found then
      return v_row;
    end if;
  end if;

  if v_origin = 'offline' and p_clock_in_at is not null then
    v_clock_in_at := least(p_clock_in_at, now());
    if v_clock_in_at < now() - interval '24 hours' then
      v_clock_in_at := now() - interval '24 hours';
    end if;
  end if;

  if public.has_overdue_feedback(v_uid, v_clock_in_at) then
    v_overdue := public.overdue_feedback_count(v_uid, v_clock_in_at);
    raise exception
      'You have feedback overdue for % class(es). Submit it before clocking in again.', v_overdue;
  end if;

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'That class could not be found.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'That class has been cancelled.';
  end if;
  if not (v_uid = any (v_event.teacher_ids)) then
    raise exception 'You are not assigned to that class.';
  end if;

  if v_event.start_at is not null
     and (v_event.start_at at time zone 'America/New_York')::date
         <> (v_clock_in_at at time zone 'America/New_York')::date then
    raise exception 'You can only clock in on the day of the class.';
  end if;

  if exists (
    select 1 from public.attendance_sessions
    where teacher_id = v_uid and event_id = p_event_id
  ) then
    raise exception 'You have already clocked in to this class.';
  end if;

  if v_event.school_id is null then
    raise exception 'This class has no matched school yet, so its location can''t be verified.';
  end if;
  select * into v_school from public.schools where id = v_event.school_id;
  if v_school.lat is null or v_school.lng is null then
    raise exception 'This school has no saved location yet — ask a manager to set it.';
  end if;

  v_distance := public.haversine_meters(p_lat, p_lng, v_school.lat, v_school.lng);
  if v_distance > v_school.geofence_radius_m then
    raise exception 'You are % m from %, outside the % m clock-in zone. Move closer and try again.',
      round(v_distance)::text, v_school.name, v_school.geofence_radius_m;
  end if;

  update public.attendance_sessions
     set clock_out_at = least(v_clock_in_at, coalesce(scheduled_end_at, v_clock_in_at)),
         clock_out_source = 'auto_next_clock_in'
   where teacher_id = v_uid and clock_out_at is null;

  v_status := case
    when v_event.start_at is not null
     and v_clock_in_at > v_event.start_at + make_interval(mins => p_grace_minutes)
    then 'late'
    else 'on_time'
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id,
    clock_in_at, clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
    clock_in_status, scheduled_start_at, scheduled_end_at, feedback_due_at,
    client_key, origin
  ) values (
    v_uid, v_event.id, v_event.school_id,
    v_clock_in_at, p_lat, p_lng, p_accuracy_m, v_distance,
    v_status, v_event.start_at, v_event.end_at,
    case when v_event.end_at is null then null else v_event.end_at + interval '24 hours' end,
    p_client_key, v_origin
  )
  returning * into v_row;

  insert into public.gps_checks (session_id, teacher_id, school_id, due_at)
  select v_row.id, v_row.teacher_id, v_row.school_id, v_row.clock_in_at + make_interval(mins => m)
  from unnest(array[15, 30, 45]) as m;

  -- They turned up. If they turned up soon enough, stop asking a manager to
  -- chase them. A class with no start_at can't be judged, so leave it alone.
  if v_event.start_at is not null
     and v_clock_in_at <= v_event.start_at + v_flag_grace then
    update public.flags
       set resolved_at = now(),
           details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
             'auto_resolved_by', 'clock_in',
             'clock_in_at', v_clock_in_at,
             'minutes_late', floor(extract(epoch from (v_clock_in_at - v_event.start_at)) / 60)::integer
           )
     where type = 'late_clock_in'
       and event_id = v_event.id
       and teacher_id = v_uid
       and resolved_at is null;
  end if;

  return v_row;
end;
$$;

comment on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) is
  'Opens an attendance session after the overdue-feedback gate, same-day check and geofence check pass. Also auto-resolves this class''s late_clock_in flag when the teacher arrives within 15 minutes of the start — the flag exists to prompt a manager to chase someone, and there is nothing left to chase.';

revoke execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) from public, anon;
grant execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) to authenticated;
