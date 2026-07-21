-- Phase 6: Offline mode & sync.
--
-- Offline clock-ins and GPS-check results are queued client-side (Dexie, see
-- src/lib/offline/*) while the device has no connectivity, then replayed
-- through POST /api/sync once back online. That endpoint runs as the teacher
-- (their cookie JWT), so every replayed record goes through the SAME
-- SECURITY DEFINER RPCs as the online path — RLS/authz are identical whether a
-- clock-in happens live or via replay. This migration only adds what the
-- offline path needs on top of Phase 4/5:
--
--   * an `origin` column ('online' | 'offline') on attendance_sessions and
--     gps_checks, so records that came in via a sync replay are labelled;
--   * clock_in() gains p_origin + p_clock_in_at — for an offline replay the
--     server trusts the client-recorded clock-in moment (CLAMPED: never in the
--     future, never more than 24h stale) so on_time/late reflects when the
--     teacher actually clocked in, not when the queue happened to drain. The
--     geofence is still re-derived server-side against the school's stored
--     coordinates exactly as before — the client's lat/lng are an input, never
--     the verdict (same rule as Phase 4);
--   * record_gps_check_offline() — resolves a due gps_checks row from a queued
--     offline sample, keyed to its session by the session's client_key + the
--     check's due offset (the offline client never sees the server-side check
--     id, since for an offline clock-in the checks don't exist until the
--     session itself syncs). Idempotency is unchanged from record_gps_check:
--     a check is only ever resolved once (status flips off 'pending'), so a
--     forced double-replay of the same sample is a no-op.
--
-- Exactly-once for clock-ins is already guaranteed by attendance_sessions'
-- client_key unique constraint + clock_in()'s idempotent replay branch (both
-- from Phase 4) — a replayed client_key returns the existing row instead of
-- inserting a duplicate. This migration doesn't change that; it only threads
-- origin/timestamp through it.

-- ---------------------------------------------------------------------------
-- origin columns
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions
  add column origin text not null default 'online'
  constraint attendance_sessions_origin_check check (origin in ('online', 'offline'));

alter table public.gps_checks
  add column origin text not null default 'online'
  constraint gps_checks_origin_check check (origin in ('online', 'offline'));

comment on column public.attendance_sessions.origin is
  '''offline'' if this session was created from a queued offline clock-in replayed via /api/sync; ''online'' otherwise.';
comment on column public.gps_checks.origin is
  '''offline'' if this check was resolved from a queued offline GPS sample; ''online'' if sampled live via record_gps_check().';

-- ---------------------------------------------------------------------------
-- clock_in(): +p_origin, +p_clock_in_at. The old 6-arg signature is dropped
-- and replaced by an 8-arg one; the two new params default so the existing
-- online caller (which passes only p_event_id..p_client_key) still resolves.
-- ---------------------------------------------------------------------------

drop function if exists public.clock_in(uuid, double precision, double precision, double precision, uuid, integer);

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
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock in.';
  end if;

  -- Idempotent replay: same client_key => return the existing session
  -- (gps_checks for it already exist from the original call). This is what
  -- makes a forcibly-replayed sync a no-op rather than a duplicate.
  if p_client_key is not null then
    select * into v_row
    from public.attendance_sessions
    where client_key = p_client_key and teacher_id = v_uid;
    if found then
      return v_row;
    end if;
  end if;

  -- For an offline replay, trust the client's recorded clock-in time so
  -- on_time/late reflects reality, but clamp it: never in the future, never
  -- more than 24h stale (a queue that old is almost certainly a bug, and
  -- backdating a whole day would silently rewrite reporting).
  if v_origin = 'offline' and p_clock_in_at is not null then
    v_clock_in_at := least(p_clock_in_at, now());
    if v_clock_in_at < now() - interval '24 hours' then
      v_clock_in_at := now() - interval '24 hours';
    end if;
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

  if exists (
    select 1 from public.attendance_sessions
    where teacher_id = v_uid and clock_out_at is null
  ) then
    raise exception 'Submit feedback for your previous class before clocking in again.';
  end if;

  if v_event.school_id is null then
    raise exception 'This class has no matched school yet, so its location can''t be verified.';
  end if;
  select * into v_school from public.schools where id = v_event.school_id;
  if v_school.lat is null or v_school.lng is null then
    raise exception 'This school has no saved location yet — ask a manager to set it.';
  end if;

  -- Server-side geofence re-validation — identical for online and offline.
  v_distance := public.haversine_meters(p_lat, p_lng, v_school.lat, v_school.lng);
  if v_distance > v_school.geofence_radius_m then
    raise exception 'You are % m from %, outside the % m clock-in zone. Move closer and try again.',
      round(v_distance)::text, v_school.name, v_school.geofence_radius_m;
  end if;

  v_status := case
    when v_event.start_at is not null
     and v_clock_in_at > v_event.start_at + make_interval(mins => p_grace_minutes)
    then 'late'
    else 'on_time'
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id,
    clock_in_at, clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
    clock_in_status, scheduled_start_at, client_key, origin
  ) values (
    v_uid, v_event.id, v_event.school_id,
    v_clock_in_at, p_lat, p_lng, p_accuracy_m, v_distance,
    v_status, v_event.start_at, p_client_key, v_origin
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

-- ---------------------------------------------------------------------------
-- apply_gps_sample(): the shared resolution core for a single gps_checks row,
-- factored out of Phase 5's record_gps_check() so the online path
-- (record_gps_check) and the offline replay path (record_gps_check_offline)
-- resolve a check — and raise the out-of-fence flag + manager notifications —
-- through ONE code path, differing only in the origin label and sampled_at.
-- Callers MUST verify ownership before calling; this does not check auth.uid()
-- itself. Internal only (no client-callable grant).
-- ---------------------------------------------------------------------------

create or replace function public.apply_gps_sample(
  p_check_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_sampled_at timestamptz,
  p_origin text
)
returns public.gps_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.gps_checks%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_school public.schools%rowtype;
  v_distance double precision;
  v_status text;
  v_origin text := case when p_origin = 'offline' then 'offline' else 'online' end;
  v_sampled timestamptz := coalesce(p_sampled_at, now());
  v_recipient uuid;
begin
  select * into v_check from public.gps_checks where id = p_check_id;
  if not found then
    raise exception 'GPS check not found.';
  end if;
  if v_check.status <> 'pending' then
    return v_check; -- already sampled or closed out; a duplicate call is a no-op.
  end if;

  select * into v_session from public.attendance_sessions where id = v_check.session_id;

  if v_session.school_id is null then
    update public.gps_checks
       set status = 'unverifiable', sampled_at = v_sampled, lat = p_lat, lng = p_lng,
           accuracy_m = p_accuracy_m, origin = v_origin
     where id = p_check_id
     returning * into v_check;
    return v_check;
  end if;

  select * into v_school from public.schools where id = v_session.school_id;
  if v_school.lat is null or v_school.lng is null then
    update public.gps_checks
       set status = 'unverifiable', sampled_at = v_sampled, lat = p_lat, lng = p_lng,
           accuracy_m = p_accuracy_m, origin = v_origin
     where id = p_check_id
     returning * into v_check;
    return v_check;
  end if;

  v_distance := public.haversine_meters(p_lat, p_lng, v_school.lat, v_school.lng);
  v_status := case when v_distance <= v_school.geofence_radius_m then 'verified' else 'out_of_fence' end;

  update public.gps_checks
     set status = v_status, sampled_at = v_sampled, lat = p_lat, lng = p_lng,
         accuracy_m = p_accuracy_m, distance_m = v_distance, origin = v_origin
   where id = p_check_id
   returning * into v_check;

  if v_status = 'out_of_fence' then
    insert into public.flags (type, session_id, event_id, teacher_id, school_id, gps_check_id, details)
    values (
      'gps_out_of_fence', v_session.id, v_session.event_id, v_check.teacher_id, v_session.school_id, v_check.id,
      jsonb_build_object(
        'distance_m', v_distance,
        'geofence_radius_m', v_school.geofence_radius_m,
        'due_at', v_check.due_at,
        'origin', v_origin
      )
    );

    for v_recipient in select * from public.notify_recipients_for_school(v_session.school_id) loop
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_recipient,
        v_session.event_id,
        'gps_out_of_fence',
        jsonb_build_object(
          'teacher_id', v_check.teacher_id,
          'session_id', v_session.id,
          'school_id', v_session.school_id,
          'distance_m', v_distance,
          'origin', v_origin
        )
      );
    end loop;
  end if;

  return v_check;
end;
$$;

revoke execute on function public.apply_gps_sample(uuid, double precision, double precision, double precision, timestamptz, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- record_gps_check(): unchanged external behaviour, now delegates the
-- resolution to apply_gps_sample() (origin='online', sampled live at now()).
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
  v_check public.gps_checks%rowtype;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_check from public.gps_checks where id = p_check_id;
  if not found or v_check.teacher_id <> v_uid then
    raise exception 'GPS check not found.';
  end if;

  return public.apply_gps_sample(p_check_id, p_lat, p_lng, p_accuracy_m, now(), 'online');
end;
$$;

revoke execute on function public.record_gps_check(uuid, double precision, double precision, double precision) from public, anon;
grant execute on function public.record_gps_check(uuid, double precision, double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- record_gps_check_offline(): resolve a due check from a queued offline
-- sample. The offline client can't reference the server-side check id (for an
-- offline clock-in the checks don't exist until the session syncs), so it
-- addresses the check by (session client_key, due offset in minutes). Matches
-- the check whose due_at == clock_in_at + offset; falls back to the nearest
-- still-pending check for that session if the exact due_at drifted. Idempotent
-- via apply_gps_sample (a non-pending check is a no-op).
-- ---------------------------------------------------------------------------

create or replace function public.record_gps_check_offline(
  p_session_client_key uuid,
  p_due_offset_min integer,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null,
  p_sampled_at timestamptz default null
)
returns public.gps_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%rowtype;
  v_check public.gps_checks%rowtype;
  v_target_due timestamptz;
  v_sampled timestamptz;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_session
  from public.attendance_sessions
  where client_key = p_session_client_key and teacher_id = v_uid;
  if not found then
    raise exception 'No clock-in found for that key.';
  end if;

  -- Clamp the sampled time the same way clock_in clamps its clock-in time.
  v_sampled := least(coalesce(p_sampled_at, now()), now());
  if v_sampled < v_session.clock_in_at then
    v_sampled := v_session.clock_in_at;
  end if;

  v_target_due := v_session.clock_in_at + make_interval(mins => p_due_offset_min);

  select * into v_check
  from public.gps_checks
  where session_id = v_session.id and due_at = v_target_due
  limit 1;

  if not found then
    select * into v_check
    from public.gps_checks
    where session_id = v_session.id and status = 'pending'
    order by abs(extract(epoch from (due_at - v_target_due)))
    limit 1;
  end if;

  if not found then
    raise exception 'No matching GPS check for that session.';
  end if;

  return public.apply_gps_sample(v_check.id, p_lat, p_lng, p_accuracy_m, v_sampled, 'offline');
end;
$$;

revoke execute on function public.record_gps_check_offline(uuid, integer, double precision, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.record_gps_check_offline(uuid, integer, double precision, double precision, double precision, timestamptz) to authenticated;
