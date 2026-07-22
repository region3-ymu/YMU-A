-- Phase 7: Notifications — Web Push subscriptions, per-type preferences, and
-- the reminder-enqueue core for notify-dispatch (Web Push + Resend email
-- backup, drained by the Edge Function on a 1-minute cron).
--
-- notification_queue already exists (Phase 3) and already accumulates
-- 'time_changed' | 'location_changed' | 'teacher_changed' | 'event_cancelled'
-- (Phase 3) and 'gps_out_of_fence' | 'late_clock_in' (Phase 5) rows, all still
-- 'pending' — this migration adds what's needed to actually send some of
-- them, plus three new reminder types this phase introduces:
--   * 'be_there_soon'      — teacher-facing, N minutes before class start
--   * 'clock_in_reminder'  — teacher-facing, at/after class start if not yet
--                            clocked in (distinct from Phase 5's manager-facing
--                            late_clock_in flag, which fires 5+ min late)
--   * 'clock_out_reminder' — teacher-facing, at/after class end if the session
--                            is still open
--
-- User-facing preference "types" are coarser than notification_queue's raw
-- `type` column: 'schedule_changed' covers time_changed/location_changed/
-- teacher_changed (Phase 3 already writes these as three distinct queue
-- types; Settings shows one combined toggle), and 'class_cancelled' covers
-- event_cancelled. The mapping lives in
-- supabase/functions/notify-dispatch/dispatch-logic.ts (NOTIFICATION_TYPE_TO_PREFERENCE),
-- not in SQL — preference enforcement happens once, at send time in the
-- dispatcher, for every type including the two Phase 3 already writes
-- unconditionally (Phase 3 predates any preference concept, so it can't have
-- checked one).
--
-- Only be_there_soon/clock_in_reminder/clock_out_reminder need a SQL-side
-- "is this due yet" computation (their whole point is firing N minutes
-- relative to an event), which is why enqueue_reminder_notifications() below
-- only generates those three — schedule_changed/class_cancelled continue to
-- be enqueued unconditionally by Phase 3's calendar-sync exactly as before.

-- ---------------------------------------------------------------------------
-- push_subscriptions — one row per browser/device endpoint. A user can have
-- several (phone + desktop). Managed entirely by the owning user's own RLS-
-- scoped client calls (subscribe = upsert on endpoint; unsubscribe = delete);
-- no RPC needed since there's nothing to validate server-side beyond
-- ownership. notify-dispatch (service_role) reads across all users' rows to
-- send, and self-cleans a row when a push provider reports the endpoint gone
-- (404/410 — see dispatch-logic.ts).
-- ---------------------------------------------------------------------------

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

comment on table public.push_subscriptions is
  'Web Push endpoints. One row per subscribed browser/device. Self-cleaned by notify-dispatch when a push provider reports the endpoint gone.';

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, delete on table public.push_subscriptions to authenticated;
grant all on table public.push_subscriptions to service_role;

create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- notification_preferences — one row per (user, user-facing type). Absence of
-- a row means "enabled, default lead time" (defaults live in
-- dispatch-logic.ts's DEFAULT_LEAD_MINUTES and are mirrored in the Settings
-- UI's placeholder values) — rows are only written when a user actually
-- changes something, so most users have zero rows.
-- ---------------------------------------------------------------------------

create table public.notification_preferences (
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (
    type in (
      'be_there_soon',
      'clock_in_reminder',
      'clock_out_reminder',
      'schedule_changed',
      'class_cancelled'
    )
  ),
  enabled boolean not null default true,
  -- Only meaningful for the three reminder types; null for schedule_changed/
  -- class_cancelled (those fire immediately on the underlying change, not on
  -- a lead time) and null for a reminder type that hasn't been customized
  -- (dispatch-logic.ts's default applies).
  lead_minutes integer check (lead_minutes is null or lead_minutes between 0 and 180),
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);

comment on table public.notification_preferences is
  'Per-user, per-type notification settings. No row for a (user, type) pair means "enabled, default lead time".';

create trigger notification_preferences_touch_updated_at
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

alter table public.notification_preferences enable row level security;
revoke all on table public.notification_preferences from anon, authenticated;
grant select, insert, update, delete on table public.notification_preferences to authenticated;
grant all on table public.notification_preferences to service_role;

create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- notification_queue: add the email-backup channel's own status columns
-- (separate from the existing status/sent_at, which — as of this phase —
-- represent the push channel specifically) and an attempts counter so
-- notify-dispatch can cap push retries instead of hammering a dead endpoint
-- forever. email_status stays null for every type that never gets an email
-- backup (be_there_soon, clock_in_reminder, gps_out_of_fence, late_clock_in);
-- it's set to 'pending' at enqueue time only for the three email-eligible
-- types (schedule_changed's three underlying queue types, class_cancelled,
-- clock_out_reminder) — see dispatch-logic.ts EMAIL_ELIGIBLE_TYPES, applied
-- when enqueue_reminder_notifications() inserts a clock_out_reminder row and,
-- for the Phase-3 types, applied by notify-dispatch itself the first time it
-- sees a pending row with no email_status yet (Phase 3's INSERTs predate this
-- column and don't set it).
-- ---------------------------------------------------------------------------

alter table public.notification_queue
  add column email_status text check (email_status in ('pending', 'sent', 'failed')),
  add column email_sent_at timestamptz,
  add column attempts integer not null default 0;

comment on column public.notification_queue.status is
  'Push-channel status: pending | sent | failed. (Predates the email backup channel below, added this phase.)';
comment on column public.notification_queue.email_status is
  'Email-backup-channel status, or null if this row''s type never gets an email backup. Capped at 100/day (Resend free tier) — see dispatch-logic.ts, oldest-pending-first.';
comment on column public.notification_queue.attempts is
  'Push send attempts. notify-dispatch stops retrying and marks the row failed past a small cap rather than retrying a dead endpoint forever.';

-- A reminder is due at most once per (recipient, event, type) no matter how
-- many times enqueue_reminder_notifications() runs in the minutes it's due —
-- ON CONFLICT below targets this exact partial index.
create unique index notification_queue_reminder_once
  on public.notification_queue (recipient_id, event_id, type)
  where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder');

create index notification_queue_email_pending_idx
  on public.notification_queue (created_at)
  where email_status = 'pending';

-- Backfill: pending rows from before this column existed (Phase 3's
-- time_changed/location_changed/teacher_changed/event_cancelled backlog)
-- are email-eligible and otherwise still pending — sweep them into the email
-- channel too rather than silently leaving every pre-Phase-7 row push-only.
update public.notification_queue
set email_status = 'pending'
where status = 'pending'
  and email_status is null
  and type in ('time_changed', 'location_changed', 'teacher_changed', 'event_cancelled');

-- ---------------------------------------------------------------------------
-- enqueue_reminder_notifications() — the notify-dispatch Edge Function's
-- first step every run. Generates be_there_soon / clock_in_reminder /
-- clock_out_reminder rows for whatever is due right now, reading each
-- teacher's own lead_minutes preference (default per type below). Idempotent
-- via the partial unique index above (ON CONFLICT ... DO NOTHING), so running
-- this every minute for however many minutes a class remains "due" is safe —
-- only the first run within the due window actually inserts a row.
--
-- Deliberately does NOT check notification_preferences.enabled: a disabled
-- row would just never be inserted, then re-checked (and still skipped) every
-- minute for no reason, AND re-enabling mid-window would never backfill a
-- reminder for a class that's already started/ended anyway, since these are
-- inherently time-relative. enabled is instead checked once, at send time,
-- in notify-dispatch — the single enforcement point for every notification
-- type, including the two Phase 3 already writes unconditionally.
-- service_role only — called from the Edge Function, never by a client.
-- ---------------------------------------------------------------------------

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
  -- be_there_soon: due when now() has entered [start_at - lead, start_at).
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

  -- clock_in_reminder: due at/after start_at + lead (default 0 = right at
  -- start), bounded to a 30-minute window (same bound as Phase 5's
  -- detect_late_clockins, so a long-down cron can't mass-fire stale
  -- reminders), only while no attendance_sessions row exists yet for that
  -- (teacher, event) — once clocked in, nothing left to remind about.
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

  -- clock_out_reminder: due at/after end_at + lead (default 0 = right at
  -- class end) for any still-open session, bounded to 6 hours past due (a
  -- session open longer than that is a known-stuck edge case for a human to
  -- resolve directly, not something to keep reminding about) — email-eligible
  -- (see dispatch-logic.ts), so email_status starts 'pending', unlike the
  -- other two reminder types.
  insert into public.notification_queue (recipient_id, event_id, type, payload, email_status)
  select a.teacher_id, a.event_id, 'clock_out_reminder',
    jsonb_build_object('session_id', a.id, 'end_at', e.end_at, 'school_id', a.school_id),
    'pending'
  from public.attendance_sessions a
  join public.calendar_events e on e.id = a.event_id
  left join public.notification_preferences p
    on p.user_id = a.teacher_id and p.type = 'clock_out_reminder'
  where a.clock_out_at is null
    and e.end_at is not null
    and now() >= e.end_at + make_interval(mins => coalesce(p.lead_minutes, 0))
    and now() < e.end_at + make_interval(mins => coalesce(p.lead_minutes, 0)) + interval '6 hours'
  on conflict (recipient_id, event_id, type) where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder')
  do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  return v_total;
end;
$$;

revoke execute on function public.enqueue_reminder_notifications() from public, anon, authenticated;
grant execute on function public.enqueue_reminder_notifications() to service_role;
