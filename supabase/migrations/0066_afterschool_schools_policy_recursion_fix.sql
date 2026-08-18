-- ===========================================================================
-- 0066 — fix: schools_select and calendar_events_select recursed
-- ===========================================================================
--
-- 0064 gave schools_select an inline
--
--   exists (select 1 from public.calendar_events e where e.school_id = schools.id ...)
--
-- and that reads calendar_events, which fires calendar_events_select, which
-- contains its own `exists (select 1 from public.schools s ...)`, which fires
-- schools_select again. Postgres cut the loop with
--
--   42P17 infinite recursion detected in policy for relation "calendar_events"
--
-- and every authenticated read of calendar_events, attendance_sessions, flags
-- and schools failed outright — including a teacher reading their own class,
-- which has nothing to do with afterschool.
--
-- teacher_has_scheduled_school() sitting two lines above in the same policy is
-- exactly this pattern, solved: a SECURITY DEFINER function reads
-- calendar_events as the owner and never re-enters RLS. Anything a policy on
-- table A needs from table B has to go through one.
-- ===========================================================================

create or replace function public.school_hosts_afterschool(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.calendar_events e
     where e.school_id = p_school_id
       and public.afterschool_owned(e.is_afterschool, e.start_at)
  );
$$;

comment on function public.school_hosts_afterschool(uuid) is
  'Does this school host an afterschool class this school year? SECURITY DEFINER so schools_select can ask without re-entering calendar_events_select, which asks schools_select back - that cycle is a 42P17 infinite recursion. Same reason teacher_has_scheduled_school() exists.';

revoke execute on function public.school_hosts_afterschool(uuid) from public, anon;
grant execute on function public.school_hosts_afterschool(uuid) to authenticated;

drop policy if exists schools_select on public.schools;
create policy schools_select on public.schools
  for select to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (region is null or region = public.current_app_region())
    )
    or public.teacher_has_scheduled_school(id)
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.school_hosts_afterschool(id)
    )
  );
