-- Clocking into the same class twice says so, instead of "something went wrong".
--
-- Found by verifying 0026 against real screens. 0026 added the partial unique
-- index attendance_one_session_per_teacher_event, which correctly rejects a
-- second session for the same (teacher, class) — but it rejects it with a raw
-- 23505. attempt_clock_in() treats any non-P0001 sqlstate as an unexpected
-- fault and masks it as "Something went wrong clocking in. Please try again."
--
-- That message is wrong twice over: nothing went wrong, and retrying can never
-- succeed. The teacher is told to do the one thing guaranteed not to help.
--
-- In normal use the UI never offers this — getNextClass() excludes events the
-- caller already has a session for (commit 863f675). The paths that do reach
-- it are the ones nobody watches: an offline queue replaying a clock-in the
-- teacher already made online, and two devices racing.
--
-- Fixed in clock_in() with an explicit guard rather than by pattern-matching
-- sqlstate in the wrapper, so the index stays a backstop for races and the
-- friendly message is the normal path. The index still catches the true
-- concurrent case, which now degrades to the same generic error as before —
-- correct, since a genuine race IS unexpected.

alter table public.clock_in_attempts
  drop constraint clock_in_attempts_outcome_check;

alter table public.clock_in_attempts
  add constraint clock_in_attempts_outcome_check check (outcome in (
    'allowed', 'allowed_replay',
    'blocked_overdue_feedback', 'blocked_geofence', 'blocked_not_assigned',
    'blocked_cancelled', 'blocked_archived', 'blocked_no_school',
    'blocked_already_attended', 'blocked_error'
  ));

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
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock in.';
  end if;

  if exists (
    select 1 from public.profiles where id = v_uid and archived_at is not null
  ) then
    raise exception 'This account has been archived and can no longer clock in.';
  end if;

  -- Idempotent replay: same client_key => return the existing session.
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

  -- The gate, evaluated at the recorded clock-in time so an offline replay is
  -- judged by the state of the world when the teacher tapped the button.
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

  -- The new guard. Checked here, after ownership, so it cannot be used to
  -- probe whether someone else has attended a class the caller isn't on.
  if exists (
    select 1 from public.attendance_sessions
    where teacher_id = v_uid and event_id = p_event_id
  ) then
    raise exception 'You have already clocked into that class.';
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
  from unnest(array[5, 10, 15, 20, 25]) as m;

  return v_row;
end;
$$;

revoke execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) from public, anon;
grant execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) to authenticated;

create or replace function public.attempt_clock_in(
  p_event_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null,
  p_client_key uuid default null,
  p_grace_minutes integer default 5,
  p_origin text default 'online',
  p_clock_in_at timestamptz default null
)
returns public.clock_in_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance_sessions;
  v_err text;
  v_state text;
  v_outcome text;
  v_overdue integer;
  v_school_id uuid;
  v_was_replay boolean := false;
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock in.';
  end if;

  v_overdue := public.overdue_feedback_count(v_uid);
  select school_id into v_school_id from public.calendar_events where id = p_event_id;

  if p_client_key is not null then
    select true into v_was_replay
    from public.attendance_sessions
    where client_key = p_client_key and teacher_id = v_uid;
  end if;

  begin
    v_row := public.clock_in(
      p_event_id, p_lat, p_lng, p_accuracy_m,
      p_client_key, p_grace_minutes, p_origin, p_clock_in_at
    );
  exception when others then
    v_err := sqlerrm;
    v_state := sqlstate;
  end;

  if v_err is null then
    v_outcome := case when coalesce(v_was_replay, false) then 'allowed_replay' else 'allowed' end;
  elsif v_state = '23505' then
    -- clock_in() guards the ordinary duplicate explicitly, so reaching the
    -- index means two devices raced. Rare, genuinely concurrent, and the
    -- honest answer is that the class is already recorded.
    v_outcome := 'blocked_already_attended';
    v_err := 'You have already clocked into that class.';
  elsif v_state <> 'P0001' then
    v_outcome := 'blocked_error';
    v_err := 'Something went wrong clocking in. Please try again.';
  elsif v_err like '%overdue%' then v_outcome := 'blocked_overdue_feedback';
  elsif v_err like '%already clocked into%' then v_outcome := 'blocked_already_attended';
  elsif v_err like '%clock-in zone%' then v_outcome := 'blocked_geofence';
  elsif v_err like '%not assigned%' then v_outcome := 'blocked_not_assigned';
  elsif v_err like '%cancelled%' then v_outcome := 'blocked_cancelled';
  elsif v_err like '%archived%' then v_outcome := 'blocked_archived';
  elsif v_err like '%no matched school%' or v_err like '%no saved location%' then v_outcome := 'blocked_no_school';
  else v_outcome := 'blocked_error';
  end if;

  insert into public.clock_in_attempts (
    teacher_id, event_id, school_id, session_id, attempted_at, origin, client_key,
    outcome, denial_message, sqlstate, lat, lng, accuracy_m, overdue_feedback_count
  ) values (
    v_uid, p_event_id, v_school_id, v_row.id,
    coalesce(p_clock_in_at, now()),
    case when p_origin = 'offline' then 'offline' else 'online' end,
    p_client_key, v_outcome,
    case when v_err is null then null else left(v_err, 500) end,
    v_state, p_lat, p_lng, p_accuracy_m, v_overdue
  );

  return (v_err is null, v_err, v_row)::public.clock_in_result;
end;
$$;

revoke execute on function public.attempt_clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) from public, anon;
grant execute on function public.attempt_clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) to authenticated;
