-- ===========================================================================
-- 0088 — a preference-disabled notification never left "pending"
-- ===========================================================================
--
-- Found while auditing the notification pipeline: 31 notification_queue rows
-- had sat in status='pending' with attempts=0 since mid-August, all
-- be_there_soon rows for one teacher (Linda Rodriguez) who has that
-- notification type disabled in her Settings.
--
-- planDispatch() (dispatch-logic.ts) already computes
-- skipReason: 'disabled_by_preference' for exactly this case, and forces
-- sendPush/sendEmail to false — that part was always correct. The bug is in
-- notify-dispatch/index.ts, which only ever wrote status/email_status for
-- rows it counted as sent, given-up, or no-device. A row skipped for a
-- disabled preference fell into none of those buckets, so nothing ever wrote
-- it back. claim_notification_batch() reclaims any 'pending' row whose lease
-- has expired, so the row got re-claimed and silently skipped again every
-- single cron run, forever — an honest opt-out, stuck churning instead of
-- settling.
--
-- This adds 'skipped' as a real terminal value. status has no check
-- constraint to widen; email_status does. The write itself happens in
-- index.ts (not SQL) — this migration only makes the value legal to store.
-- ===========================================================================

alter table public.notification_queue
  drop constraint notification_queue_email_status_check;

alter table public.notification_queue
  add constraint notification_queue_email_status_check
  check (email_status = any (array['pending', 'sent', 'failed', 'skipped']));

comment on column public.notification_queue.status is
  'Push-channel status: pending | sent | failed | no_device | skipped (skipped = recipient disabled this notification type in Settings; see notify-dispatch/index.ts).';

comment on column public.notification_queue.email_status is
  'Email-backup-channel status, or null if this row''s type never gets an email backup. Capped at 100/day (Resend free tier) — see dispatch-logic.ts, oldest-pending-first. skipped = recipient disabled this notification type in Settings.';
