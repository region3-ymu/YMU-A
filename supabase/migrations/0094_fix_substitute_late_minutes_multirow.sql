-- ===========================================================================
-- 0094 — 0093's substitute_late_minutes() raised 21000 on a tie
-- ===========================================================================
-- Caught by tests/afterschool-rls.test.ts: "more than one row returned by a
-- subquery used as an expression". Two classes ending at the exact same
-- instant (shared bell schedule, or two rows for a co-taught class) made the
-- scalar-subquery form of substitute_late_minutes() return more than one row.
-- max() resolves the tie by taking the more-late of the two, which is the
-- conservative answer anyway. 0093's file on disk now carries this fix so a
-- fresh replay doesn't reintroduce the bug.
-- ===========================================================================

create or replace function public.substitute_late_minutes(
  p_teacher_id uuid,
  p_school_id  uuid,
  p_start      timestamptz
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(greatest(0, ceil(
           public.travel_minutes(e.school_id, p_school_id)
           - extract(epoch from (p_start - e.end_at)) / 60.0
         ))::integer), 0)
    from public.calendar_events e
   where p_teacher_id = any(e.teacher_ids)
     and e.status <> 'cancelled'
     and e.end_at <= p_start
     and e.school_id is distinct from p_school_id
     and e.end_at = (
           select max(e2.end_at)
             from public.calendar_events e2
            where p_teacher_id = any(e2.teacher_ids)
              and e2.status <> 'cancelled'
              and e2.end_at <= p_start
         );
$$;

comment on function public.substitute_late_minutes(uuid, uuid, timestamptz) is
  'Minutes this teacher would be late arriving to a class at p_school_id starting p_start, given the nearest different-school class immediately before it — 0 if they''d be on time or early, or if there is no such class. max() over any tie at the same end_at. substitute_available() tolerates up to 15; find_substitutes() surfaces the number so a manager can see it before calling.';
