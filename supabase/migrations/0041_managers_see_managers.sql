-- Managers can see each other.
--
-- "Transfer ownership" on a ticket showed an empty dropdown for every Regional
-- Manager. `getAssignableAgents()` reads `profiles` under RLS, and
-- `can_read_profile` (0033) only let an RM through on a region match — with an
-- explicit `region is not null` guard. The CPO and the Academic Manager both
-- carry a null region, and another region's RM carries a different one, so an
-- RM matched nobody but themselves. A one-option list, and that option was
-- already the owner.
--
-- The region scoping exists to keep one region's manager out of ANOTHER
-- region's teachers — names, phone numbers, attendance. It was never meant to
-- hide colleagues from each other. Every manager is already a possible
-- assignee of every ticket: `ticket_owner_for_school()` routes across all of
-- them, `reassign_ticket()` accepts any non-teacher, and 0030's ticket policy
-- lets OM/CPO/academic_manager read every ticket in the company regardless of
-- region. Hiding the names while permitting the transfer was the inconsistency.
--
-- Scoped deliberately narrowly: manager-sees-manager. A manager's view of
-- TEACHERS keeps every regional restriction 0033 established, which is the part
-- that actually protects someone.

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
        -- Colleagues. Any non-teacher may be handed a ticket, so any non-teacher
        -- has to be nameable in the list that hands it over.
        exists (
          select 1 from public.profiles p
           where p.id = p_profile_id and p.role <> 'teacher'
        )
        -- Managers and anyone else carrying this manager's own region.
        or exists (
          select 1 from public.profiles p
           where p.id = p_profile_id
             and p.region is not null
             and p.region = public.current_app_region()
        )
        -- Teachers, via the schools they are scheduled at — windowed to the
        -- live roster. Unchanged from 0033; see its header for why the window
        -- is measured from each class's END.
        or exists (
          select 1
            from public.calendar_events ce
            join public.schools s on s.id = ce.school_id
           where ce.teacher_ids @> array[p_profile_id]
             and s.region = public.current_app_region()
             and coalesce(ce.end_at, ce.start_at) >= now() - interval '1 day'
        )
        -- Anyone who has actually worked in this region.
        or exists (
          select 1 from public.attendance_sessions a
            join public.schools s on s.id = a.school_id
           where a.teacher_id = p_profile_id
             and s.region = public.current_app_region()
        )
        -- Anyone who has raised a ticket in this region, or one this manager
        -- personally owns.
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
  'Who a signed-in user may read from profiles. Managers can always see other managers — every one of them is a possible ticket assignee, so hiding the names while permitting the transfer only broke the transfer. Regional scoping still applies in full to TEACHERS, which is what it was for. SECURITY DEFINER because it reads tickets and calendar_events, whose own policies read profiles.';
