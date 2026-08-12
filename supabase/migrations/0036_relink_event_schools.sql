-- Classes attributed to the wrong school.
--
-- Reported 2026-08-12 by Kevin Bodniza, who saw Young Men's Preparatory
-- Academy and North Miami MS in his schedule and teaches at neither. He was
-- right, and RLS was not the problem: every one of those events really does
-- carry his address as a Google Calendar attendee, and
-- `calendar_events_select` already restricts a teacher to `auth.uid() = ANY
-- (teacher_ids)`. What was wrong was the SCHOOL each class was filed under.
--
-- His 180 "Young Men's Preparatory Academy" classes come from the calendar
-- pinned to **Horace Mann Middle School**, which is exactly where he does
-- teach. The class was right; the label on it was not.
--
-- The cause is the same shape as the teacher-linkage bug that 0035 fixed. A
-- calendar's school is resolved when an event is first written, and the sync
-- is incremental — Google only returns what changed. So every time a school's
-- pin was corrected (Hialeah/Homestead, Dr. William Chapman, John A. Ferguson,
-- and the re-subscription of all 111 calendars), the events already stored
-- kept pointing at whichever school the pin used to name. 2,598 events across
-- 9 schools, 686 of them still in the future.
--
-- This is worse than a wrong label. `school_id` is what clock-in validates the
-- geofence against, and the mismatched pairs are up to 11 km apart — a teacher
-- standing in their own classroom would have been told they were nowhere near
-- it. It is also what routes a ticket to a region.
--
-- Safe to run now precisely because the operational tables were just reset:
-- no attendance_session or feedback row points at the old attribution, so
-- nothing historical is being rewritten.

create or replace function public.relink_event_schools(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  -- The pin is the authority: an event that came from a calendar belongs to
  -- whichever school that calendar is pinned to, now, not when it was stored.
  -- google_calendar_id is unique on schools, so this cannot be ambiguous.
  update public.calendar_events e
     set school_id = s.id,
         school_match_source = 'calendar_pin',
         school_match_score = 1,
         updated_at = now()
    from public.schools s
   where s.google_calendar_id = e.calendar_id
     and e.school_id is distinct from s.id
     and (p_from is null or e.start_at >= p_from)
     and (p_to is null or e.start_at < p_to);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.relink_event_schools(timestamptz, timestamptz) is
  'Re-files every event under the school its calendar is currently pinned to. Run after re-pinning a school''s calendar — the incremental sync will not revisit events Google considers unchanged, so they keep the old school and, with it, the wrong geofence.';

revoke execute on function public.relink_event_schools(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.relink_event_schools(timestamptz, timestamptz) to service_role;
