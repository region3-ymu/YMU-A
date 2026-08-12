-- "Teacher Unknown" on every ticket a Regional Manager opens.
--
-- The ticket list and detail page embed the reporter with
-- `teacher:profiles!tickets_teacher_id_fkey(full_name, phone)`. RLS on
-- profiles let a regional_manager read a row only when
-- `region = current_app_region()` — but **profiles.region is null by design
-- for teachers**, which migration 0021 states outright: a teacher works at
-- whatever schools their calendar sends them to, often across regions, so
-- there is no single region to store.
--
-- So the RM could read no teacher profile at all. PostgREST does not error on
-- that; the embedded join just comes back null and the page renders its
-- fallback. All 58 teachers were affected, on every ticket.
--
-- 0021 already solved the same problem for /lists by deriving a teacher's
-- region from calendar_events -> schools.region. It did it inside
-- `teacher_directory()`, a SECURITY DEFINER function that bypasses RLS
-- entirely — which is exactly why the directory looked fine while the ticket
-- pages did not, and why the gap went unnoticed. This migration moves that
-- same rule into the policy, so it applies to every reader rather than to one
-- hand-written function.
--
-- Two further fixes ride along:
--   * academic_manager was missing from the policy entirely. It reads every
--     ticket (0030) but could not read the reporters' names, so it had the
--     same broken page.
--   * A teacher whose schedule changes after raising a ticket would lose their
--     name from a ticket already in the queue. The ticket's own denormalized
--     `region` covers that case.

-- A SECURITY DEFINER predicate, not an inline subquery. The policy needs to
-- read tickets and calendar_events, and both of those have policies that read
-- profiles — inline, that is mutual recursion. Running the check as the
-- definer sidesteps RLS on the inner tables, the same way current_app_role()
-- already does.
create or replace function public.can_read_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_profile_id = (select auth.uid())
    or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
    or (
      public.current_app_role() = 'regional_manager'
      and (
        -- Managers and anyone else who does carry a region.
        exists (
          select 1 from public.profiles p
           where p.id = p_profile_id
             and p.region is not null
             and p.region = public.current_app_region()
        )
        -- Teachers, via the schools they are scheduled at — same basis as
        -- teacher_directory() (0021), but WINDOWED to the live roster.
        --
        -- The window is what makes this clause mean "who works for me now"
        -- instead of "who has ever set foot in my region". The calendar holds
        -- three school years, and a single shared date drags everyone in with
        -- it: 206 "Concert" events at one Central school during Relay week
        -- carry 57 different teachers, which unwindowed would have handed
        -- Central's manager almost the entire company.
        --
        -- Measured from the END, not the start, so a class that finished an
        -- hour ago still resolves a name — that is the ticket the teacher
        -- just raised. Anything older is covered by the two clauses below.
        -- Uses the GIN index on teacher_ids.
        or exists (
          select 1
            from public.calendar_events ce
            join public.schools s on s.id = ce.school_id
           where ce.teacher_ids @> array[p_profile_id]
             and s.region = public.current_app_region()
             and coalesce(ce.end_at, ce.start_at) >= now() - interval '1 day'
        )
        -- Anyone who has actually worked in this region. This is what keeps
        -- older reports readable once the 30-day calendar window has rolled
        -- past them: every report row is built from attendance_sessions, so
        -- anyone who appears in one has a name here.
        or exists (
          select 1 from public.attendance_sessions a
            join public.schools s on s.id = a.school_id
           where a.teacher_id = p_profile_id
             and s.region = public.current_app_region()
        )
        -- Anyone who has raised a ticket in this region, or a ticket this
        -- manager personally owns. Without this, re-assigning a class to
        -- another school silently blanks the reporter's name on a ticket
        -- already sitting in the queue.
        or exists (
          select 1 from public.tickets t
           where t.teacher_id = p_profile_id
             and (
               t.region = public.current_app_region()
               or t.assigned_agent_id = (select auth.uid())
             )
        )
      )
    );
$$;

comment on function public.can_read_profile(uuid) is
  'Who a signed-in user may read from profiles. SECURITY DEFINER because it reads tickets and calendar_events, whose own policies read profiles — inline that would recurse.';

revoke execute on function public.can_read_profile(uuid) from public, anon;
grant execute on function public.can_read_profile(uuid) to authenticated;

drop policy if exists profiles_select on public.profiles;

create policy profiles_select on public.profiles
  for select to authenticated
  using (public.can_read_profile(id));
