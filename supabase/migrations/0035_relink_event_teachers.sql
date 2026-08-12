-- Re-link teachers to classes that were already synced.
--
-- The calendar sync resolves an event's attendee emails to app accounts at the
-- moment it writes the event, and it syncs INCREMENTALLY — Google returns only
-- what changed since the last token. Both are correct on their own, and
-- together they leave a gap nobody sees: fixing a teacher's email, or creating
-- their account at all, does not retroactively attach them to classes that
-- were stored before. Google considers those events unchanged, so they are
-- never returned again, so the linkage is never recomputed.
--
-- It bit on 2026-08-12. Jose Heredia's login was corrected and Lilia Hernandez
-- was created the same day; between them they hold 450 classes in the 2026-27
-- calendar, every one of which stayed teacher-less through a full sync. The
-- teacher simply has no class to clock into, and nothing anywhere reports it.
--
-- Re-syncing from scratch would fix it by discarding every sync token and
-- re-reading 111 calendars, which is slow and throws away the incremental
-- state for an unrelated reason. The attendee list is already stored on every
-- row, so the answer is here in the database.

create or replace function public.relink_event_teachers(
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
  with teachers as (
    -- Mirrors loadTeachers() in supabase/functions/calendar-sync/sync.ts:
    -- non-archived teachers only, matched on a trimmed, lower-cased email.
    select lower(btrim(u.email)) as email, p.id
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.role = 'teacher' and p.archived_at is null and u.email is not null
  ),
  matched as (
    select e.id as event_id, array_agg(distinct t.id) as teacher_ids
      from public.calendar_events e
      cross join lateral jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
      join teachers t on t.email = lower(btrim(a->>'email'))
     where (p_from is null or e.start_at >= p_from)
       and (p_to is null or e.start_at < p_to)
     group by e.id
  )
  update public.calendar_events e
     -- UNION, never replace. mergeTeacherIds() in the sync does the same: a
     -- teacher already attached by an earlier pass stays attached even if the
     -- current invite no longer names them, so removing someone from a class
     -- remains a deliberate act rather than a side effect of a re-link.
     set teacher_ids = (
           select array_agg(distinct x)
             from unnest(e.teacher_ids || m.teacher_ids) as x
         ),
         updated_at = now()
    from matched m
   where m.event_id = e.id
     and not (e.teacher_ids @> m.teacher_ids);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.relink_event_teachers(timestamptz, timestamptz) is
  'Recomputes calendar_events.teacher_ids from the stored attendee list. Run after creating a teacher account or correcting a login email — the incremental calendar sync will not revisit events Google considers unchanged.';

revoke execute on function public.relink_event_teachers(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.relink_event_teachers(timestamptz, timestamptz) to service_role;
