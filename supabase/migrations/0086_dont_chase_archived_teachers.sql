-- ===========================================================================
-- 0086 — stop chasing teachers who have left
-- ===========================================================================
--
-- YMU 2026-08-27: Alejandra Pizarro is no longer with YMU. Archive her so her
-- classes stop raising flags.
--
-- Archiving alone would have made it worse. `archiveTeacher` sets
-- profiles.archived_at and nothing else — it does not touch
-- calendar_events.teacher_ids, and she is still an attendee on 169 future
-- classes at Irving & Beatrice Peskoe. detect_late_clockins() excludes only
-- clock_in_exempt teachers, so every one of those 169 classes would have raised
-- a flag AND pushed a notification to her Regional Manager, for a teacher who
-- cannot comply: clock_in() refuses an archived account outright.
--
-- So the app would have spent the rest of the school year asking a manager to
-- chase someone who no longer works there and could not clock in if she tried.
--
-- ── This is an inconsistency, not a design choice ────────────────────────
--
-- Every other sweep already excludes archived teachers. Checked:
--
--   clock_in()                     excludes archived
--   relink_event_teachers()        excludes archived
--   auto_attend_exempt_teachers()  excludes archived
--   auto_clock_in_back_to_back()   excludes archived
--   detect_late_clockins()         DID NOT                 <- the odd one out
--
-- ── What this does not fix ───────────────────────────────────────────────
--
-- Her name stays on those 169 Google Calendar events, so Attendance and Reports
-- will show them as 'missed' for her until somebody edits the calendar — either
-- removing her or naming her replacement. That is YMU's calendar work and the
-- app cannot invent it. What changes here is that nobody gets chased about it.
--
-- Body below is 0077's verbatim apart from one added condition.
-- ===========================================================================

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
      -- 0086 adds `or p.archived_at is not null`. An archived teacher is
      -- refused by clock_in() outright, so flagging them for not clocking in
      -- asks a manager to chase someone who cannot comply. Every other sweep
      -- already skipped them; this one did not.
      and not exists (
        select 1 from public.profiles p
        where p.id = t.teacher_id
          and (p.clock_in_exempt or p.archived_at is not null)
      )
      -- 0077: an active carryover rule plus a clock-in on the immediately
      -- preceding class at the same school means the teacher is already
      -- accounted for.
      and not exists (
        select 1
          from public.calendar_events prev_ce
          join public.attendance_sessions prev
            on prev.event_id = prev_ce.id and prev.teacher_id = t.teacher_id
          cross join lateral (
            select public.auto_clock_in_rule_gap(
              ce.school_id, t.teacher_id, prev_ce.summary, ce.summary
            ) as max_gap_minutes
          ) rule
         where prev_ce.school_id = ce.school_id
           and t.teacher_id = any(prev_ce.teacher_ids)
           and prev_ce.status <> 'cancelled'
           and prev_ce.id <> ce.id
           and prev_ce.end_at is not null
           and rule.max_gap_minutes is not null
           and prev_ce.end_at >= ce.start_at - make_interval(mins => rule.max_gap_minutes)
           and prev_ce.end_at <= ce.start_at + interval '5 minutes'
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
        public.manager_notification_payload(v_flag.teacher_id, v_flag.school_id, v_flag.event_id)
          || jsonb_build_object('flag_id', v_flag.id)
      );
    end loop;
  end loop;

  return v_count;
end;
$$;

comment on function public.detect_late_clockins() is
  'Raises a late_clock_in flag five minutes after a class starts with no attendance session, and notifies the school''s managers. Skips clock-in-exempt teachers, archived teachers, and the second class of a covered back-to-back run.';
