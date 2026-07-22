-- Phase 9: close two silent-observability gaps found while auditing PRD §14's
-- error-handling requirements.
--
-- calendar_sync_state and notification_queue have both had real failure state
-- written to them since Phase 3/7 (a 410 from Google, a push send that gave
-- up past its attempts cap) — but neither table has ever had an authenticated
-- grant at all, so that failure state has been invisible to every manager,
-- logged server-side only. This migration only adds read access; no write
-- behavior changes.

-- ---------------------------------------------------------------------------
-- calendar_sync_state — same manager-only read shape as calendar_sync_issues
-- (0007_calendar_sync_issues.sql).
-- ---------------------------------------------------------------------------

grant select on public.calendar_sync_state to authenticated;

create policy calendar_sync_state_select on public.calendar_sync_state
  for select to authenticated
  using (public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo'));

-- ---------------------------------------------------------------------------
-- notification_queue — a teacher can see their own queue rows (their own
-- notification history); any manager can see all rows (a "notifications
-- failing" dashboard count doesn't need per-row region precision, and this
-- table has no school_id/region column to scope by — a deliberate
-- simplification, not an oversight).
-- ---------------------------------------------------------------------------

grant select on public.notification_queue to authenticated;

create policy notification_queue_select on public.notification_queue
  for select to authenticated
  using (
    recipient_id = auth.uid()
    or public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo')
  );
