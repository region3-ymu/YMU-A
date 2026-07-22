-- Phase 9: teacher-archive defense-in-depth, stuck-feedback-session
-- detection, and an admin force-close fallback.
--
-- Also repurposes zoho_synced_at. Its original "push feedback to Zoho via
-- API" origin is dead (Phase 4's rework made Zoho the SOURCE of feedback, via
-- an embedded form + inbound webhook, not a destination — see DECISIONS.md/
-- NEXT_STEPS.md's "likely vestigial" notes). Going forward it means "this
-- session was closed by the real Zoho webhook", set only on
-- close_session_from_zoho()'s actual closing branch below. The three new
-- admin_closed_* columns mean the opposite: "an OM/CPO force-closed this
-- instead, because Zoho's webhook never arrived" — the two closing paths are
-- mutually exclusive by construction, so the columns give a clean audit trail
-- without overloading one column's meaning.

-- ---------------------------------------------------------------------------
-- clock_in(): defense-in-depth against an archived teacher clocking in via a
-- queued offline replay. /api/sync only checks auth.getUser() (a valid
-- session cookie), never archived_at — so a teacher archived after queuing an
-- offline clock-in, but before their session cookie expires, could reach
-- clock_in() via /api/sync entirely bypassing the app-level login gate. Same
-- 8-arg signature as 0013_offline_sync.sql; only the new check is added.
-- ---------------------------------------------------------------------------

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

  if exists (
    select 1 from public.profiles where id = v_uid and archived_at is not null
  ) then
    raise exception 'This account has been archived and can no longer clock in.';
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
-- attendance_sessions: admin force-close audit columns. Mutually exclusive
-- with zoho_synced_at by construction — only one closing path ever runs per
-- row (close_session_from_zoho's early-return no-ops if already closed, and
-- admin_close_stuck_session below does the same).
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions
  add column admin_closed_at timestamptz,
  add column admin_closed_by uuid references public.profiles (id),
  add column admin_closed_reason text;

comment on column public.attendance_sessions.zoho_synced_at is
  'Set only when this session was closed by the real Zoho webhook (close_session_from_zoho). Null if force-closed by an admin instead (see admin_closed_at).';
comment on column public.attendance_sessions.admin_closed_at is
  'Set when an OM/CPO force-closed this session via admin_close_stuck_session because Zoho''s webhook never arrived. Mutually exclusive with zoho_synced_at.';
comment on column public.attendance_sessions.admin_closed_by is
  'The OM/CPO profile who force-closed this session, if any.';
comment on column public.attendance_sessions.admin_closed_reason is
  'Required free-text reason given for a force-close, shown in reports/audit views.';

-- ---------------------------------------------------------------------------
-- close_session_from_zoho(): same 5-arg signature as 0011, now also stamps
-- zoho_synced_at on the real closing branch (not the idempotent early-return,
-- which already carries whatever was set on the original close).
-- ---------------------------------------------------------------------------

create or replace function public.close_session_from_zoho(
  p_session_id uuid,
  p_engagement text,
  p_had_issue text,
  p_issue_status text default null,
  p_notes text default null
)
returns public.attendance_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_row public.attendance_sessions;
begin
  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'No attendance session found for id %.', p_session_id;
  end if;

  if v_row.clock_out_at is not null then
    return v_row; -- already closed; a retried webhook delivery is a no-op success.
  end if;

  if p_engagement is null or btrim(p_engagement) = '' then
    raise exception 'Engagement is required.';
  end if;
  if p_had_issue is null or p_had_issue not in ('Yes', 'No') then
    raise exception 'Had issue must be Yes or No.';
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         feedback_engagement = btrim(p_engagement),
         feedback_had_issue = p_had_issue,
         feedback_issue_status = nullif(btrim(coalesce(p_issue_status, '')), ''),
         feedback_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         feedback_submitted_at = now(),
         zoho_synced_at = now()
   where id = p_session_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_zoho(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.close_session_from_zoho(uuid, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- flags: widen for the new 'feedback_stuck' type, same shape as
-- gps_out_of_fence/late_clock_in (Phase 5). Partial unique index makes the
-- detector idempotent per session, mirroring flags_late_clock_in_once.
-- ---------------------------------------------------------------------------

alter table public.flags drop constraint flags_type_check;
alter table public.flags add constraint flags_type_check
  check (type in ('gps_out_of_fence', 'late_clock_in', 'feedback_stuck'));

create unique index flags_feedback_stuck_once
  on public.flags (session_id)
  where type = 'feedback_stuck';

-- ---------------------------------------------------------------------------
-- detect_stuck_feedback_sessions(): flags any attendance_sessions row still
-- open (Zoho's webhook never arrived) past the given threshold. Modeled
-- directly on detect_late_clockins(). The 6-hour default matches
-- clock_out_reminder's own "6 hours past due is a known-stuck edge case for a
-- human to resolve" threshold, chosen in 0014_notifications.sql. service_role
-- only — called from a new cron-scheduled Edge Function.
-- ---------------------------------------------------------------------------

create or replace function public.detect_stuck_feedback_sessions(p_stuck_after_hours integer default 6)
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
      jsonb_build_object('clock_in_at', a.clock_in_at, 'scheduled_start_at', a.scheduled_start_at)
    from public.attendance_sessions a
    where a.clock_out_at is null
      and a.clock_in_at < now() - make_interval(hours => p_stuck_after_hours)
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
        jsonb_build_object(
          'teacher_id', v_flag.teacher_id,
          'flag_id', v_flag.id,
          'session_id', v_flag.session_id,
          'school_id', v_flag.school_id
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
-- admin_close_stuck_session(): the manual fallback when Zoho's webhook never
-- arrives. OM/CPO only (tighter than resolve_flag's RM-allowed-but-region-
-- checked pattern — force-closing someone's attendance record is a higher-
-- stakes action than resolving an escalation card). Requires a non-empty
-- reason; idempotent (no-op if already closed by either path); deliberately
-- leaves every feedback_* column null — this is not a stand-in for the
-- teacher's real answers, just an unblock. Resolves the associated
-- feedback_stuck flag, if any, as a side effect.
-- ---------------------------------------------------------------------------

create or replace function public.admin_close_stuck_session(p_session_id uuid, p_reason text)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance_sessions;
begin
  if v_uid is null or coalesce(public.current_app_role() in ('operations_manager', 'cpo'), false) is false then
    raise exception 'Only an operations manager or the CPO can force-close a stuck session.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to force-close a session.';
  end if;

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found.';
  end if;
  if v_row.clock_out_at is not null then
    return v_row; -- already closed (e.g. Zoho's webhook landed a moment later); no-op.
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         admin_closed_at = now(),
         admin_closed_by = v_uid,
         admin_closed_reason = btrim(p_reason)
   where id = p_session_id
   returning * into v_row;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = details || jsonb_build_object('resolution_notes', 'Force-closed: ' || btrim(p_reason))
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.admin_close_stuck_session(uuid, text) from public, anon;
grant execute on function public.admin_close_stuck_session(uuid, text) to authenticated;
