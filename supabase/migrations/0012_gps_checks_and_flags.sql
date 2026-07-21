-- Phase 5: GPS checks & late escalation.
--
-- Two new tables:
--   gps_checks   — 5 rows created at clock-in (due +5/+10/+15/+20/+25 min),
--                  sampled client-side while the app is foregrounded, closed
--                  out as 'unverifiable' (neutral) by a cron job if unrun.
--   flags        — manager-facing escalations: an actual out-of-fence GPS
--                  reading, or a missed clock-in (start + 5 min, no session).
--                  Not visible to teachers (see RLS below) — this is a
--                  manager tool, unlike attendance_sessions/gps_checks which
--                  teachers also read as their own record.
--
-- Both new mutation paths that touch flags/notification_queue run as
-- SECURITY DEFINER (record_gps_check, called by the teacher client) or
-- service_role only (detect_late_clockins/close_out_overdue_gps_checks,
-- called by the two new Edge Functions) — same authorization shape as
-- clock_in()/close_session_from_zoho() in Phase 4.

-- ---------------------------------------------------------------------------
-- gps_checks
-- ---------------------------------------------------------------------------

create table public.gps_checks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.attendance_sessions (id) on delete cascade,
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  -- Denormalized from the session at creation time, purely so this table's
  -- RLS can mirror attendance_sessions_select's region-scoping without a join.
  school_id uuid references public.schools (id) on delete set null,
  due_at timestamptz not null,
  -- 'pending' (not yet due or due but unsampled) -> one of:
  --   'verified'     — sampled, inside the fence
  --   'out_of_fence' — sampled, outside the fence (raises a flag)
  --   'unverifiable' — never sampled by its due time; closed out neutrally,
  --                    no flag (app backgrounded/locked is expected, not
  --                    suspicious on its own)
  status text not null default 'pending',
  sampled_at timestamptz,
  lat double precision,
  lng double precision,
  accuracy_m double precision,
  distance_m double precision,
  created_at timestamptz not null default now(),
  constraint gps_checks_status_check
    check (status in ('pending', 'verified', 'out_of_fence', 'unverifiable'))
);

comment on table public.gps_checks is
  '5 rows per attendance session (due +5/10/15/20/25 min after clock-in). Written by clock_in() (creation) and record_gps_check()/close_out_overdue_gps_checks() (resolution) only — no direct authenticated writes.';

create index gps_checks_session_idx on public.gps_checks (session_id);
create index gps_checks_teacher_idx on public.gps_checks (teacher_id);
-- Drives both the client's "which of my due checks haven't been sampled yet"
-- poll and the closeout job's "which pending checks are now overdue" sweep.
create index gps_checks_pending_due_idx on public.gps_checks (due_at) where status = 'pending';

alter table public.gps_checks enable row level security;
revoke all on table public.gps_checks from anon, authenticated;
grant select on table public.gps_checks to authenticated;
grant all on table public.gps_checks to service_role;

create policy gps_checks_select on public.gps_checks
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
          where s.id = gps_checks.school_id
            and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- flags — manager escalations. No teacher-visible policy at all: this is a
-- tool for the Regional Manager / OM / CPO to act on, not part of a
-- teacher's own record (unlike attendance_sessions/gps_checks above).
-- ---------------------------------------------------------------------------

create table public.flags (
  id uuid primary key default gen_random_uuid(),
  -- 'gps_out_of_fence' | 'late_clock_in'. Text, not an enum, since only this
  -- migration's own functions ever write here — same rationale as
  -- notification_queue.type.
  type text not null,
  session_id uuid references public.attendance_sessions (id) on delete cascade,
  event_id uuid references public.calendar_events (id) on delete set null,
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  school_id uuid references public.schools (id) on delete set null,
  gps_check_id uuid references public.gps_checks (id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id),
  constraint flags_type_check
    check (type in ('gps_out_of_fence', 'late_clock_in'))
);

comment on table public.flags is
  'Manager-facing escalations only — not readable by the teacher the flag is about. Written by record_gps_check() (gps_out_of_fence) and detect_late_clockins() (late_clock_in); resolved via resolve_flag().';

create index flags_school_idx on public.flags (school_id);
create index flags_open_idx on public.flags (created_at) where resolved_at is null;
-- Backstop against detect_late_clockins() re-flagging the same missed
-- clock-in on every cron tick; the function's own NOT EXISTS check is the
-- primary guard, this makes it race-proof.
create unique index flags_late_clock_in_once
  on public.flags (event_id, teacher_id)
  where type = 'late_clock_in';

alter table public.flags enable row level security;
revoke all on table public.flags from anon, authenticated;
grant select on table public.flags to authenticated;
grant all on table public.flags to service_role;

create policy flags_select on public.flags
  for select to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
          where s.id = flags.school_id
            and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- notify_recipients_for_school: who gets a notification_queue row for an
-- incident at this school. Regional Manager(s) of the school's region if any
-- exist; otherwise OM/CPO (the same "escalate up" shape as the calendar-sync
-- issue queue being visible to OM/CPO region-wide) rather than silently
-- creating no notification at all. Runs unprivileged (no security definer)
-- but is only ever called from within the security definer/service_role
-- functions below, so it executes with their bypass-RLS context.
-- ---------------------------------------------------------------------------

create or replace function public.notify_recipients_for_school(p_school_id uuid)
returns setof uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_region public.region;
  v_rm_count integer;
begin
  if p_school_id is not null then
    select region into v_region from public.schools where id = p_school_id;
  end if;

  if v_region is not null then
    select count(*) into v_rm_count
    from public.profiles
    where role = 'regional_manager' and region = v_region;

    if v_rm_count > 0 then
      return query
        select id from public.profiles where role = 'regional_manager' and region = v_region;
      return;
    end if;
  end if;

  return query
    select id from public.profiles where role in ('operations_manager', 'cpo');
end;
$$;

-- ---------------------------------------------------------------------------
-- clock_in(): unchanged signature, re-defined to also seed the 5 gps_checks
-- rows due +5/10/15/20/25 min after this clock-in. Same function body as
-- 0008_attendance.sql otherwise.
-- ---------------------------------------------------------------------------

create or replace function public.clock_in(
  p_event_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null,
  p_client_key uuid default null,
  p_grace_minutes integer default 5
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
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock in.';
  end if;

  -- Idempotent replay: same client_key => return the existing session
  -- (gps_checks for it already exist from the original call).
  if p_client_key is not null then
    select * into v_row
    from public.attendance_sessions
    where client_key = p_client_key and teacher_id = v_uid;
    if found then
      return v_row;
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

  v_distance := public.haversine_meters(p_lat, p_lng, v_school.lat, v_school.lng);
  if v_distance > v_school.geofence_radius_m then
    raise exception 'You are % m from %, outside the % m clock-in zone. Move closer and try again.',
      round(v_distance)::text, v_school.name, v_school.geofence_radius_m;
  end if;

  v_status := case
    when v_event.start_at is not null
     and now() > v_event.start_at + make_interval(mins => p_grace_minutes)
    then 'late'
    else 'on_time'
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id,
    clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
    clock_in_status, scheduled_start_at, client_key
  ) values (
    v_uid, v_event.id, v_event.school_id,
    p_lat, p_lng, p_accuracy_m, v_distance,
    v_status, v_event.start_at, p_client_key
  )
  returning * into v_row;

  insert into public.gps_checks (session_id, teacher_id, school_id, due_at)
  select v_row.id, v_row.teacher_id, v_row.school_id, v_row.clock_in_at + make_interval(mins => m)
  from unnest(array[5, 10, 15, 20, 25]) as m;

  return v_row;
end;
$$;

revoke execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer) from public, anon;
grant execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- record_gps_check: called by the teacher's own client when a due check is
-- sampled. Verifies ownership, re-derives the fence distance server-side
-- (same haversine_meters() pattern as clock_in — the client's lat/lng are an
-- input, never the verdict), and on an actual out-of-fence reading raises a
-- flag + queues a manager notification. Idempotent: re-calling on an
-- already-resolved check just returns it.
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
  v_session public.attendance_sessions%rowtype;
  v_school public.schools%rowtype;
  v_distance double precision;
  v_status text;
  v_recipient uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_check from public.gps_checks where id = p_check_id;
  if not found or v_check.teacher_id <> v_uid then
    raise exception 'GPS check not found.';
  end if;

  if v_check.status <> 'pending' then
    return v_check; -- already sampled or closed out; a duplicate client call is a no-op.
  end if;

  select * into v_session from public.attendance_sessions where id = v_check.session_id;

  if v_session.school_id is null then
    update public.gps_checks
       set status = 'unverifiable', sampled_at = now(), lat = p_lat, lng = p_lng, accuracy_m = p_accuracy_m
     where id = p_check_id
     returning * into v_check;
    return v_check;
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
        jsonb_build_object(
          'teacher_id', v_uid,
          'session_id', v_session.id,
          'school_id', v_session.school_id,
          'distance_m', v_distance
        )
      );
    end loop;
  end if;

  return v_check;
end;
$$;

revoke execute on function public.record_gps_check(uuid, double precision, double precision, double precision) from public, anon;
grant execute on function public.record_gps_check(uuid, double precision, double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- close_out_overdue_gps_checks: the check-closeout Edge Function's core.
-- Marks any still-pending check whose due_at has passed as 'unverifiable' —
-- neutral, no flag (per the plan: a missed check on its own, e.g. app
-- backgrounded/phone locked, is not suspicious). service_role only.
-- ---------------------------------------------------------------------------

create or replace function public.close_out_overdue_gps_checks()
returns integer
language sql
set search_path = ''
as $$
  with updated as (
    update public.gps_checks
       set status = 'unverifiable'
     where status = 'pending' and due_at < now()
     returning id
  )
  select count(*)::integer from updated;
$$;

revoke execute on function public.close_out_overdue_gps_checks() from public, anon, authenticated;
grant execute on function public.close_out_overdue_gps_checks() to service_role;

-- ---------------------------------------------------------------------------
-- detect_late_clockins: the late-detect Edge Function's core. Flags any
-- scheduled class, more than 5 minutes past its start, with a matched
-- teacher who has no attendance_sessions row for it at all (not "late",
-- literally never clocked in) — and queues a manager notification per flag.
-- The 30-minute lookback bounds the sweep to recent misses regardless of how
-- often the cron actually runs; a teacher who never clocks in at all still
-- reflects as "no session" indefinitely in reporting, just not re-flagged
-- forever here. service_role only.
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
        jsonb_build_object('teacher_id', v_flag.teacher_id, 'flag_id', v_flag.id, 'school_id', v_flag.school_id)
      );
    end loop;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.detect_late_clockins() from public, anon, authenticated;
grant execute on function public.detect_late_clockins() to service_role;

-- ---------------------------------------------------------------------------
-- resolve_flag: a manager marking a flag as handled (e.g. after making the
-- two escalation calls). Same role/region shape as assign_event_school.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_flag(p_flag_id uuid, p_notes text default null)
returns public.flags
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_flag public.flags%rowtype;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if v_role not in ('regional_manager', 'operations_manager', 'cpo') then
    raise exception 'Only managers can resolve flags.';
  end if;

  select * into v_flag from public.flags where id = p_flag_id;
  if not found then
    raise exception 'Flag not found.';
  end if;

  if v_role = 'regional_manager' and v_flag.school_id is not null then
    if not exists (
      select 1 from public.schools s
      where s.id = v_flag.school_id and (s.region is null or s.region = public.current_app_region())
    ) then
      raise exception 'You can only resolve flags in your own region.';
    end if;
  end if;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = details || jsonb_build_object('resolution_notes', p_notes)
   where id = p_flag_id
   returning * into v_flag;

  return v_flag;
end;
$$;

revoke execute on function public.resolve_flag(uuid, text) from public, anon;
grant execute on function public.resolve_flag(uuid, text) to authenticated;
