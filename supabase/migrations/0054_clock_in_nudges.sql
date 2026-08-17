-- Make the clock-in reminder insist.
--
-- Forgetting to clock in is the pilot's single biggest problem, and the app
-- currently asks once: enqueue_reminder_notifications fires one
-- clock_in_reminder at class start and never mentions it again. On iPhone —
-- where 25 of the 27 subscribed teachers are — that one notification cannot be
-- made louder, cannot vibrate on our terms, cannot mark itself Time Sensitive
-- and can be swallowed entirely by a Focus mode or the Scheduled Summary.
-- Apple gives a web app no lever for any of that.
--
-- What IS available is asking again. Three nudges instead of one, stopping the
-- moment they clock in:
--
--   nudge 1  at class start          "Class has started"
--   nudge 2  +5 minutes              "Still not clocked in"
--   nudge 3  +10 minutes             "Last reminder"
--
-- The +5 one lands at the same moment detect_late_clockins() raises the flag to
-- their manager, which is deliberate: the teacher hears about it before their
-- Regional Manager does.
--
-- Anyone who clocks in on time still gets exactly one notification, because
-- every nudge re-checks for a session. This adds volume only for the teachers
-- who were about to be marked absent anyway.

-- ---------------------------------------------------------------------------
-- Room for more than one reminder per class
-- ---------------------------------------------------------------------------
-- notification_queue_reminder_once made (recipient, event, type) unique for the
-- three reminder types, which is exactly what stopped the 1-minute cron
-- re-sending the same nudge every minute — that part must not change. The key
-- just needs to distinguish nudge 1 from nudge 2. coalesce, not a bare
-- expression: NULLs are distinct in a unique index, so a null nudge would
-- silently opt every existing row out of the constraint.

drop index if exists public.notification_queue_reminder_once;

create unique index notification_queue_reminder_once
  on public.notification_queue (recipient_id, event_id, type, coalesce(payload->>'nudge', '1'))
  where type in ('be_there_soon', 'clock_in_reminder', 'clock_out_reminder');

comment on index public.notification_queue_reminder_once is
  'One row per (recipient, class, reminder type, nudge). The nudge component lets the clock-in reminder repeat at +5 and +10 minutes while still making the every-minute dispatch cron idempotent.';

-- ---------------------------------------------------------------------------
-- The nudge schedule
-- ---------------------------------------------------------------------------

create or replace function public.clock_in_nudge_offsets()
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select array[0, 5, 10];
$$;

comment on function public.clock_in_nudge_offsets() is
  'Minutes after class start at which to re-ask a teacher to clock in. Each is skipped if a session already exists, so a punctual teacher still sees only the first.';

grant execute on function public.clock_in_nudge_offsets() to authenticated, service_role;

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
    and not exists (
      select 1 from public.profiles pr
      where pr.id = t.teacher_id and pr.clock_in_exempt
    )
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- One row per (teacher, class, nudge). A nudge becomes due once its offset
  -- has passed and stays due for 30 minutes, so a cron tick that misses its
  -- exact minute still delivers it. `nudge` is 1-based and lands in the payload
  -- so notify-dispatch can word the third reminder differently from the first.
  insert into public.notification_queue (recipient_id, event_id, type, payload)
  select
    t.teacher_id, e.id, 'clock_in_reminder',
    jsonb_build_object(
      'summary', e.summary,
      'start_at', e.start_at,
      'school_id', e.school_id,
      'nudge', n.ord::text,
      'minutes_late', n.offset_minutes
    )
  from public.calendar_events e
  cross join lateral unnest(e.teacher_ids) as t (teacher_id)
  cross join lateral unnest(public.clock_in_nudge_offsets()) with ordinality as n (offset_minutes, ord)
  left join public.notification_preferences p
    on p.user_id = t.teacher_id and p.type = 'clock_in_reminder'
  where e.status <> 'cancelled'
    and e.start_at is not null
    -- Where the teacher has asked for a different lead, it shifts the whole
    -- ladder rather than only the first rung.
    and now() >= e.start_at
      + make_interval(mins => coalesce(p.lead_minutes, 0) + n.offset_minutes)
    and now() < e.start_at
      + make_interval(mins => coalesce(p.lead_minutes, 0) + n.offset_minutes) + interval '30 minutes'
    -- The whole point: every rung re-checks. Clock in and the rest never fire.
    and not exists (
      select 1 from public.attendance_sessions a
      where a.event_id = e.id and a.teacher_id = t.teacher_id
    )
    and not exists (
      select 1 from public.profiles pr
      where pr.id = t.teacher_id and pr.clock_in_exempt
    )
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  insert into public.notification_queue (recipient_id, event_id, type, payload, email_status)
  select a.teacher_id, a.event_id, 'clock_out_reminder',
    jsonb_build_object(
      'session_id', a.id,
      'summary', e.summary,
      'end_at', e.end_at,
      'due_at', a.feedback_due_at,
      'school_id', a.school_id
    ),
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
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  return v_total;
end;
$$;

comment on function public.enqueue_reminder_notifications() is
  'Generates due be_there_soon / clock_in_reminder / clock_out_reminder rows. The clock-in reminder repeats on clock_in_nudge_offsets() until a session exists. Skips teachers flagged clock_in_exempt.';
