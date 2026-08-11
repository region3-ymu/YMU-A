-- The 24-hour feedback grace window.
--
-- This supersedes Phase 4's core decision, recorded in DECISIONS.md as "the
-- open session IS the Demand": today `clock_out_at IS NULL` means BOTH "the
-- teacher is still in class" AND "feedback is owed" AND "feedback is blocking
-- the next clock-in". Back-to-back classes make that fuse a real problem — a
-- teacher physically cannot stop and fill a form before the next class starts,
-- so the block fires when it shouldn't.
--
-- The whole change is splitting that one column into three predicates:
--
--   still in class     -> clock_out_at IS NULL          (unchanged meaning)
--   feedback owed      -> feedback_settled_at IS NULL   (new)
--   feedback BLOCKING  -> feedback_settled_at IS NULL
--                         AND feedback_due_at < now()   (new)
--
-- Closes the "🟡 FUTURE" item in NEXT_STEPS.md.
--
-- ONE MIGRATION ON PURPOSE. The idempotency guards in close_session_from_zoho
-- and close_session_with_relay_feedback CANNOT ship in a different deploy from
-- automatic clock-out — see the comment above section 6 for why splitting them
-- silently destroys teacher feedback.

begin;

-- ===========================================================================
-- 1. Schema
-- ===========================================================================

alter table public.attendance_sessions
  add column scheduled_end_at timestamptz,
  add column feedback_due_at timestamptz,
  add column clock_out_source text;

alter table public.attendance_sessions
  add constraint attendance_clock_out_source_check
  check (clock_out_source is null or clock_out_source in (
    'teacher', 'auto_end_of_class', 'auto_next_clock_in',
    'feedback', 'admin', 'zoho', 'relay', 'legacy'
  ));

-- Generated rather than a canonical column plus a backfill. Three different
-- writers currently stamp three different "the obligation is discharged"
-- columns (Zoho's feedback_submitted_at, the relay form's
-- relay_feedback_submitted_at, and a manager's admin_closed_at waiver). A
-- generated column reads all three correctly on day one with zero UPDATE, and
-- a future fourth provider cannot silently forget to write it — the failure
-- shows up at the ALTER that adds it to this coalesce, not in production.
alter table public.attendance_sessions
  add column feedback_settled_at timestamptz
  generated always as (
    coalesce(feedback_submitted_at, relay_feedback_submitted_at, admin_closed_at)
  ) stored;

comment on column public.attendance_sessions.scheduled_end_at is
  'Snapshot of calendar_events.end_at at clock-in. Snapshotted for the same reason scheduled_start_at is (0008): a later calendar re-sync mutates end_at freely, and a teacher''s feedback deadline must not move with it.';
comment on column public.attendance_sessions.feedback_due_at is
  'scheduled_end_at + 24h. NULL never blocks — an all-day event or an admin-created row with no end_at must not brick clock-in.';
comment on column public.attendance_sessions.feedback_settled_at is
  'Generated: the moment the feedback obligation was discharged, by any path (Zoho, relay form, or an admin waiver). This, not clock_out_at, is what "feedback owed" now reads.';
comment on column public.attendance_sessions.clock_out_source is
  'How the session was closed. Distinguishes a teacher genuinely clocking out from cron closing it for them — the difference matters for the compliance score.';

create index attendance_feedback_owed_idx
  on public.attendance_sessions (teacher_id, feedback_due_at)
  where feedback_settled_at is null;

-- The invariant commit 863f675 worked around in JS (queries.ts builds an
-- "already attended" Set client-side) and admin_create_attendance enforces by
-- hand. With the feedback gate gone, nothing else stops a teacher clocking
-- into the same event twice.
create unique index attendance_one_session_per_teacher_event
  on public.attendance_sessions (teacher_id, event_id)
  where event_id is not null;

-- ===========================================================================
-- 2. Backfill
-- ===========================================================================

update public.attendance_sessions a
   set scheduled_end_at = ce.end_at
  from public.calendar_events ce
 where ce.id = a.event_id
   and a.scheduled_end_at is null;

update public.attendance_sessions
   set feedback_due_at = scheduled_end_at + interval '24 hours'
 where feedback_due_at is null
   and scheduled_end_at is not null;

-- Amnesty. Every session open today is by definition older than the deadline
-- it would have been given, so a naive backfill blocks those teachers the
-- instant this lands — strictly worse than the status quo it replaces.
-- Everyone still owing feedback gets a fresh 24 hours from deploy.
update public.attendance_sessions
   set feedback_due_at = greatest(coalesce(feedback_due_at, now()), now() + interval '24 hours')
 where feedback_settled_at is null
   and clock_out_at is null;

-- Provenance for history, so the compliance score doesn't read NULL as
-- "the teacher clocked out".
update public.attendance_sessions
   set clock_out_source = case
     when admin_closed_at is not null then 'admin'
     when zoho_synced_at is not null then 'zoho'
     when relay_feedback_submitted_at is not null then 'relay'
     else 'legacy'
   end
 where clock_out_at is not null
   and clock_out_source is null;

-- ===========================================================================
-- 3. The gate helpers
-- ===========================================================================

create or replace function public.has_overdue_feedback(
  p_teacher_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.attendance_sessions
    where teacher_id = p_teacher_id
      and feedback_settled_at is null
      and feedback_due_at is not null
      and feedback_due_at < p_at
  );
$$;

comment on function public.has_overdue_feedback(uuid, timestamptz) is
  'True when the teacher has any feedback more than 24h past its class end. security definer so it returns the same answer called from inside clock_in() and from a teacher''s own JWT.';

create or replace function public.overdue_feedback_count(
  p_teacher_id uuid,
  p_at timestamptz default now()
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.attendance_sessions
  where teacher_id = p_teacher_id
    and feedback_settled_at is null
    and feedback_due_at is not null
    and feedback_due_at < p_at;
$$;

revoke execute on function public.has_overdue_feedback(uuid, timestamptz) from public, anon;
revoke execute on function public.overdue_feedback_count(uuid, timestamptz) from public, anon;
grant execute on function public.has_overdue_feedback(uuid, timestamptz) to authenticated;
grant execute on function public.overdue_feedback_count(uuid, timestamptz) to authenticated;

-- ===========================================================================
-- 4. clock_in() — same 8-arg signature, so no grant churn and no caller change
-- ===========================================================================

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

  -- THE GATE. Evaluated at v_clock_in_at rather than now() so an offline
  -- replay is judged by the state of the world when the teacher actually
  -- tapped the button — a teacher who clocked in at 09:00 while compliant and
  -- syncs at 14:00 after a deadline passed is not retroactively rejected. Same
  -- principle 0017 already applied to on_time/late, and the 24h clamp above
  -- bounds how far back that can reach.
  --
  -- Any overdue item blocks, and all must be cleared. "Only the oldest blocks"
  -- produces a rolling wall: clear one, tap Clock in, blocked by the next.
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

  -- Close any still-open session BEFORE inserting. This is what makes
  -- back-to-back classes work: a teacher clocking into the 14:00 class at
  -- 13:56 still has the 13:00 class open, and the partial unique index
  -- attendance_one_open_session_per_teacher would reject the insert with a raw
  -- 23505. Doing it here, in the same transaction as the insert, makes that
  -- collision structurally impossible rather than merely unlikely.
  --
  -- The close time never runs past the class's own scheduled end, so an
  -- auto-close cannot invent hours that were not scheduled.
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

-- ===========================================================================
-- 5. clock_out() and the cron sweep
-- ===========================================================================

create or replace function public.clock_out(p_session_id uuid default null)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock out.';
  end if;

  if p_session_id is null then
    select * into v_row from public.attendance_sessions
    where teacher_id = v_uid and clock_out_at is null
    order by clock_in_at desc limit 1;
    if not found then
      raise exception 'You are not clocked in to any class right now.';
    end if;
  else
    select * into v_row from public.attendance_sessions where id = p_session_id;
    if not found or v_row.teacher_id <> v_uid then
      raise exception 'That clock-in session could not be found.';
    end if;
  end if;

  -- Idempotent: a double-tap or a retry returns the row unchanged, matching
  -- the no-op-on-retry contract close_session_from_zoho already sets.
  if v_row.clock_out_at is not null then
    return v_row;
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         clock_out_source = 'teacher'
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.clock_out(uuid) from public, anon;
grant execute on function public.clock_out(uuid) to authenticated;

comment on function public.clock_out(uuid) is
  'Ends a class. Touches no feedback column — feedback is a separate obligation with its own 24h deadline.';

-- The safety net for a teacher who walks away and doesn't teach again for
-- days. Stamps the scheduled end, not now(), so a session closed three days
-- late still reports the hours it was actually scheduled for.
create or replace function public.auto_clock_out_ended_sessions(p_grace_minutes integer default 15)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.attendance_sessions
     set clock_out_at = scheduled_end_at,
         clock_out_source = 'auto_end_of_class'
   where clock_out_at is null
     and scheduled_end_at is not null
     and scheduled_end_at + make_interval(mins => p_grace_minutes) < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.auto_clock_out_ended_sessions(integer) from public, anon, authenticated;
grant execute on function public.auto_clock_out_ended_sessions(integer) to service_role;

-- ===========================================================================
-- 6. The feedback RPCs stop owning clock_out_at
--
-- READ THIS BEFORE EDITING. Both functions currently early-return when
-- clock_out_at IS NOT NULL, treating it as "a retried delivery". Once
-- automatic clock-out exists, clock_out_at is routinely non-null when a
-- genuine first-time submission arrives — and the old guard would swallow it
-- and return success. The teacher's feedback would be lost with no error
-- anywhere. That is why the guard moves to the feedback column in the SAME
-- migration that introduces auto clock-out, never a deploy later.
-- ===========================================================================

create or replace function public.close_session_with_relay_feedback(
  p_session_id uuid,
  p_relay_block text,
  p_program_area text,
  p_objective text,
  p_achieved_objective text,
  p_objective_reflection text,
  p_engagement_scale smallint,
  p_challenges text[],
  p_pivots text default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit feedback.';
  end if;

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found or v_row.teacher_id <> v_uid then
    raise exception 'That clock-in session could not be found.';
  end if;
  if v_row.relay_feedback_submitted_at is not null then
    raise exception 'You have already submitted feedback for this class.';
  end if;

  if p_relay_block is null or btrim(p_relay_block) = '' then
    raise exception 'Please select the relay block.';
  end if;
  if p_program_area is null or btrim(p_program_area) = '' then
    raise exception 'Please select the program area.';
  end if;
  if p_objective is null or btrim(p_objective) = '' then
    raise exception 'Please describe your main objective for this lesson.';
  end if;
  if p_achieved_objective is null or btrim(p_achieved_objective) = '' then
    raise exception 'Please select whether you achieved your objective.';
  end if;
  if p_objective_reflection is null or btrim(p_objective_reflection) = '' then
    raise exception 'Please add an objective reflection.';
  end if;
  if p_engagement_scale is null or p_engagement_scale < 1 or p_engagement_scale > 5 then
    raise exception 'Please rate engagement from 1 to 5.';
  end if;
  if p_challenges is null or array_length(p_challenges, 1) is null then
    raise exception 'Please select at least one challenge option (or "None / Everything went smoothly").';
  end if;

  update public.attendance_sessions
     set relay_block = p_relay_block,
         relay_program_area = p_program_area,
         relay_objective = btrim(p_objective),
         relay_achieved_objective = p_achieved_objective,
         relay_objective_reflection = btrim(p_objective_reflection),
         relay_engagement_scale = p_engagement_scale,
         relay_challenges = p_challenges,
         relay_pivots = nullif(btrim(coalesce(p_pivots, '')), ''),
         relay_feedback_submitted_at = now(),
         -- Courtesy close, so the simple one-class case still feels like
         -- "finishing the form finishes the class". Never later than the
         -- scheduled end, and never overwrites an existing clock-out.
         clock_out_at = coalesce(clock_out_at, least(now(), coalesce(scheduled_end_at, now()))),
         clock_out_source = coalesce(clock_out_source, 'feedback')
   where id = p_session_id
   returning * into v_row;

  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: relay feedback submitted in-app')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.close_session_with_relay_feedback(uuid, text, text, text, text, text, smallint, text[], text) from public, anon;
grant execute on function public.close_session_with_relay_feedback(uuid, text, text, text, text, text, smallint, text[], text) to authenticated;

create or replace function public.close_session_from_zoho(
  p_session_id uuid,
  p_engagement text,
  p_had_issue text,
  p_issue_status text default null,
  p_notes text default null,
  p_teacher_id uuid default null
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

  if p_teacher_id is not null and v_row.teacher_id <> p_teacher_id then
    raise exception 'Feedback does not match the session owner.';
  end if;

  -- Keyed on the feedback column, NOT clock_out_at — see the section header.
  if v_row.feedback_submitted_at is not null then
    return v_row; -- a retried webhook delivery is a no-op success.
  end if;

  if p_engagement is null or btrim(p_engagement) = '' then
    raise exception 'Engagement is required.';
  end if;
  if p_had_issue is null or p_had_issue not in ('Yes', 'No') then
    raise exception 'Had issue must be Yes or No.';
  end if;

  update public.attendance_sessions
     set feedback_engagement = btrim(p_engagement),
         feedback_had_issue = p_had_issue,
         feedback_issue_status = nullif(btrim(coalesce(p_issue_status, '')), ''),
         feedback_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         feedback_submitted_at = now(),
         zoho_synced_at = now(),
         clock_out_at = coalesce(clock_out_at, least(now(), coalesce(scheduled_end_at, now()))),
         clock_out_source = coalesce(clock_out_source, 'feedback')
   where id = p_session_id
   returning * into v_row;

  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: Zoho feedback received')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_zoho(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.close_session_from_zoho(uuid, text, text, text, text, uuid) to service_role;

-- ===========================================================================
-- 7. Detectors and reminders that read the old predicate
--
-- These move in the same migration for the same reason as section 6: left
-- alone, detect_stuck_feedback_sessions() escalates EVERY teacher inside their
-- legitimate grace window within 6 hours, turning /flags into noise on day
-- one, and enqueue_reminder_notifications() goes silent the moment cron starts
-- clocking people out — the exact opposite of what a 24h window needs.
-- ===========================================================================

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
      -- p_stuck_after_hours is now a grace period AFTER the deadline, not a
      -- window measured from clock-in. Default 0 = escalate as soon as the
      -- 24h window lapses, which is the same moment clock-in starts blocking.
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
  -- Keyed on feedback, not clock_out_at, so a manager can still waive the
  -- feedback on a session cron already clocked out.
  if v_row.feedback_settled_at is not null then
    return v_row;
  end if;

  update public.attendance_sessions
     set clock_out_at = coalesce(clock_out_at, now()),
         clock_out_source = coalesce(clock_out_source, 'admin'),
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

-- enqueue_reminder_notifications(): only the clock_out_reminder block changes
-- (predicate + window). The type name stays — it is baked into a CHECK, the
-- notification_queue_reminder_once partial unique index, and
-- EMAIL_ELIGIBLE_TYPES in dispatch-logic.ts. Only its user-facing copy moves,
-- in TypeScript.
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
  on conflict (recipient_id, event_id, type) where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder')
  do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- clock_out_reminder now means "your feedback is owed", keyed on
  -- feedback_settled_at rather than clock_out_at, and bounded by the real 24h
  -- deadline instead of an invented 6-hour window.
  insert into public.notification_queue (recipient_id, event_id, type, payload, email_status)
  select a.teacher_id, a.event_id, 'clock_out_reminder',
    jsonb_build_object(
      'session_id', a.id,
      'summary', e.summary,
      'end_at', e.end_at,
      'due_at', a.feedback_due_at,
      'school_id', a.school_id
    ),
    'pending'
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

revoke execute on function public.enqueue_reminder_notifications() from public, anon, authenticated;
grant execute on function public.enqueue_reminder_notifications() to service_role;

-- ===========================================================================
-- 8. Clock-in attempt audit log
--
-- The PRD wants every attempt logged, allowed or blocked (ITL Domain 5). The
-- obstacle is real: a RAISE EXCEPTION aborts the transaction and takes any
-- INSERT in the same function with it — precisely the blocked rows that matter
-- most. Postgres has no autonomous transactions, and pg_net and NOTIFY are
-- both transactional too, so neither is a way out.
--
-- The way out is a subtransaction. A PL/pgSQL BEGIN ... EXCEPTION block
-- establishes an implicit savepoint; catching the exception rolls back only to
-- that savepoint, so the outer transaction survives and its INSERT commits.
-- ===========================================================================

create table public.clock_in_attempts (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  event_id uuid references public.calendar_events (id) on delete set null,
  -- Denormalized purely so RLS can region-scope without a join, exactly as
  -- gps_checks does (0012).
  school_id uuid references public.schools (id) on delete set null,
  session_id uuid references public.attendance_sessions (id) on delete set null,
  attempted_at timestamptz not null default now(),
  origin text not null default 'online',
  client_key uuid,
  outcome text not null,
  denial_message text,
  sqlstate text,
  lat double precision,
  lng double precision,
  accuracy_m double precision,
  overdue_feedback_count integer,
  created_at timestamptz not null default now(),
  constraint clock_in_attempts_outcome_check check (outcome in (
    'allowed', 'allowed_replay',
    'blocked_overdue_feedback', 'blocked_geofence', 'blocked_not_assigned',
    'blocked_cancelled', 'blocked_archived', 'blocked_no_school', 'blocked_error'
  ))
);

comment on table public.clock_in_attempts is
  'Every clock-in attempt, allowed or blocked. Written by attempt_clock_in() from OUTSIDE the subtransaction that runs clock_in(), so a blocked attempt survives the RAISE that rolls clock_in() back.';

create index clock_in_attempts_teacher_idx on public.clock_in_attempts (teacher_id, attempted_at desc);
create index clock_in_attempts_blocked_idx on public.clock_in_attempts (attempted_at) where outcome <> 'allowed';

alter table public.clock_in_attempts enable row level security;
revoke all on table public.clock_in_attempts from anon, authenticated;
grant select on table public.clock_in_attempts to authenticated;
grant all on table public.clock_in_attempts to service_role;

-- Mirrors attendance_sessions_select (0008): own rows, OM/CPO everything, RM
-- scoped to their region. school_id null stays visible to managers rather than
-- disappearing.
create policy clock_in_attempts_select on public.clock_in_attempts
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
          where s.id = clock_in_attempts.school_id
            and s.region = public.current_app_region()
        )
      )
    )
  );

create type public.clock_in_result as (
  ok boolean,
  error_message text,
  session public.attendance_sessions
);

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

  -- The subtransaction. Everything clock_in() wrote — the session row, its
  -- five gps_checks, the auto-close of a prior session — is rolled back on
  -- error, but this block's caller keeps going.
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
  elsif v_state <> 'P0001' then
    -- Not one of our own RAISEs (a unique violation from two concurrent
    -- clock-ins, say). Deliberately not shown verbatim to a teacher.
    v_outcome := 'blocked_error';
    v_err := 'Something went wrong clocking in. Please try again.';
  elsif v_err like '%overdue%' then v_outcome := 'blocked_overdue_feedback';
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

comment on function public.attempt_clock_in(uuid, double precision, double precision, double precision, uuid, integer, text, timestamptz) is
  'Logged wrapper around clock_in(). Returns (ok, error_message, session) instead of raising for a policy denial, so the caller can render a friendly message AND the attempt is recorded. clock_in() itself is unchanged and still raises.';

commit;
