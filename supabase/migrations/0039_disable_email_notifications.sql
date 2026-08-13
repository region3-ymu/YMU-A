-- Turn the Resend email channel off at the source.
--
-- `ymu.org` publishes no SPF, DKIM or DMARC, so Resend refuses to relay for it
-- and every email-eligible notification fails. YMU's call (2026-08-13): stop
-- attempting email until the DNS is sorted, so it stops showing up as an error.
--
-- Done HERE rather than by unsetting RESEND_API_KEY or editing
-- dispatch-logic.ts, for one reason: this is the switch that works with no
-- deploy. planDispatch() only sends when `row.email_status === 'pending'`, so a
-- row enqueued with a null email_status is never even considered — no attempt,
-- no failure, nothing on the dashboard. Whichever version of the Edge Function
-- is live obeys it.
--
-- clock_out_reminder is the only type this function ever marked email-eligible.
-- The calendar-sync types (event_cancelled, time_changed, …) already enqueue
-- with a null email_status, so nothing else needs touching.
--
-- THE BODY BELOW IS THE LIVE FUNCTION, COPIED VERBATIM, with one literal
-- changed: `'pending'` → `null`. It is deliberately not reconstructed from the
-- earlier migration files, which have drifted from production — they still say
-- `e.status = 'confirmed'`, a two-hour clock-in window and `coalesce(e.end_at,
-- a.clock_in_at)`, where production says `<> 'cancelled'`, thirty minutes and
-- `a.scheduled_end_at`. Rewriting from those would have quietly reverted three
-- behaviour changes while turning off an email.
--
-- To switch email back on once DNS is fixed: put `'pending'` back. Nothing else
-- was removed — EMAIL_ELIGIBLE_TYPES, the daily cap and the whole send path are
-- untouched and still work.

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
  -- feedback_settled_at and bounded by the real 24h deadline instead of an
  -- invented 6-hour window.
  insert into public.notification_queue (recipient_id, event_id, type, payload, email_status)
  select a.teacher_id, a.event_id, 'clock_out_reminder',
    jsonb_build_object(
      'session_id', a.id,
      'summary', e.summary,
      'end_at', e.end_at,
      'due_at', a.feedback_due_at,
      'school_id', a.school_id
    ),
    -- WAS 'pending'. This single null is the entire email switch.
    null
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

-- Clear the failures already on the board: they record attempts against a
-- channel that is now off and will never be retried, so leaving them would keep
-- the dashboard reporting an error nobody is going to act on.
update public.notification_queue
   set email_status = null
 where email_status in ('pending', 'failed');
