-- ===========================================================================
-- 0082 — remove the mid-class GPS checks
-- ===========================================================================
--
-- They never worked, and the reason is structural rather than a bug worth
-- fixing. 649 of 654 checks are 'unverifiable' with no position ever recorded;
-- 4 succeeded, all sampled 18-33 seconds after coming due.
--
-- The sampler (src/components/gps-check-sampler.tsx) can only take a fix while
-- the app is FOREGROUNDED — it stops on visibilitychange. Nobody holds a phone
-- open for eighty minutes while teaching a band class, and no web API fixes
-- that: a service worker has no navigator.geolocation, and Periodic Background
-- Sync is Chromium-only and grants no location. A grace period was drafted and
-- would have raised the hit rate for a teacher who happened to glance at the
-- app mid-class, which is not the same as measuring whether they stayed.
--
-- YMU (2026-08-21): remove it. A table that says 'unverifiable' 649 times is
-- worse than no table, because it looks like evidence.
--
-- ── What is explicitly NOT touched ───────────────────────────────────────
--
-- The clock-in. Every gate in clock_in() stays exactly as it is: the geofence,
-- the archived check, the overdue-feedback block, the idempotent client_key,
-- the offline timestamp clamp, the same-day rule, and the auto-close of the
-- previous open session. A teacher can still clock in at any point during
-- their class if they have not yet — that behaviour is the same-day rule with
-- no upper bound, and it is untouched.
--
-- The ONE line removed from clock_in() is the insert that created the three
-- check rows. Everything else in this migration is dropping what read them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Stop the cron before removing what it calls
-- ---------------------------------------------------------------------------
-- Order matters. check-closeout-1min POSTs to an Edge Function that calls
-- close_out_overdue_gps_checks() every minute; dropping the function first
-- would leave a job erroring 1,440 times a day into cron.job_run_details.
--
-- Wrapped because cron.unschedule raises if the job is already gone, and this
-- migration has to be safe to replay.

do $$
begin
  perform cron.unschedule('check-closeout-1min');
exception
  when others then
    raise notice 'check-closeout-1min was not scheduled; nothing to unschedule.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. clock_in() without the check rows
-- ---------------------------------------------------------------------------
-- Body is the live 0044 definition verbatim apart from the deleted insert.
-- Reproduced in full rather than patched because that is how every other
-- migration in this project has redefined it (0008, 0012, 0013, 0017, 0026,
-- 0028, 0044) and a reader comparing two versions should be able to diff them.

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

  -- Same day, with no upper bound inside it. This is what lets a teacher clock
  -- in at any point during their class, including after it has started, and it
  -- is deliberately unchanged.
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

  -- What makes back-to-back classes work: the partial unique index
  -- attendance_one_open_session_per_teacher allows one open session, and the
  -- least() clamp means an auto-close can never invent unscheduled hours.
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

  -- The three gps_checks rows at +15/+30/+45 used to be created here. That is
  -- the only removal.

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
  'Opens an attendance session for the caller''s own class. Geofenced, same-day, one per class, idempotent on client_key. A teacher may clock in at any point during the class. No longer schedules mid-class GPS checks — that mechanism was removed in 0082.';

-- ---------------------------------------------------------------------------
-- 3. Drop what read the checks
-- ---------------------------------------------------------------------------

drop function if exists public.gps_checks_for_sheet(timestamptz, timestamptz);
drop function if exists public.record_gps_check(uuid, double precision, double precision, double precision);
drop function if exists public.record_gps_check_offline(uuid, integer, double precision, double precision, double precision, timestamptz);
drop function if exists public.close_out_overdue_gps_checks();
drop function if exists public.close_out_overdue_gps_checks(integer);

-- flags.gps_check_id only ever pointed at this table, and the flag type it
-- belonged to (gps_out_of_fence) was raised exclusively by record_gps_check().
-- Zero such flags were ever raised, so there is no history to preserve.
alter table public.flags drop column if exists gps_check_id;

drop table if exists public.gps_checks;

-- 'gps_out_of_fence' stays in the flags type check constraint. Nothing can
-- raise it now, and narrowing the constraint is a change with a failure mode
-- (an unmigrated row) and no benefit. flags_for_sheet() keeps its label for
-- the same reason: cheap, and correct if one ever turns up.

-- ---------------------------------------------------------------------------
-- 4. Left for the deploy
-- ---------------------------------------------------------------------------
-- supabase/functions/check-closeout/ is deleted in the same commit as this
-- migration but lives in Supabase's Edge Function registry until removed
-- there. The cron that called it is unscheduled above, so it is inert either
-- way. To tidy it up:
--
--   supabase functions delete check-closeout
