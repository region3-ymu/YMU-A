-- Fixes a real, confirmed bug found while investigating a user report:
-- Regional Managers saw "Unknown teacher" on the Manager Dashboard for a
-- real, correctly-assigned teacher.
--
-- Root cause: profiles.region is null-by-design for teachers since Phase 3
-- (a teacher's region derives from the schools their events are at, not from
-- their own profile — see DECISIONS.md). But profiles_select RLS
-- (0002_profiles_rls.sql) still gates a Regional Manager's visibility of ANY
-- profiles row by `region is not null and region = current_app_region()`,
-- which a teacher's row (region always null) can never satisfy. Every read
-- that resolves a teacher's name/phone for a Regional Manager via a plain
-- `profiles` select or a PostgREST embed of `profiles` therefore silently
-- returns null for that teacher, no matter how correctly they're assigned.
--
-- report_teacher_roster() (Phase 8, 0016_reports.sql) already got this right
-- for Reports by scoping Regional Managers via calendar_events -> schools.region
-- instead of profiles.region — its own comment already flags this as the
-- reason it deliberately does NOT reuse teacher_directory(). This migration:
--   1. Extends report_teacher_roster() with `phone`, so it can also back the
--      dashboard/flags/search reads that need a phone number (the "call the
--      teacher" flow on /flags), not just Reports.
--   2. Fixes teacher_directory() (0005_schools.sql, backs /lists) to use the
--      SAME calendar-events-based region scoping — it had the identical bug,
--      silently returning zero teachers to every Regional Manager on /lists,
--      just never reported because an empty list reads as "no teachers yet"
--      rather than a visible "Unknown teacher" label.

drop function if exists public.report_teacher_roster(boolean);

create or replace function public.report_teacher_roster(p_include_archived boolean default false)
returns table (
  id uuid,
  full_name text,
  email text,
  phone text,
  archived_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.id, p.full_name, u.email, p.phone, p.archived_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
    and (p_include_archived or p.archived_at is null)
    and (
      public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and exists (
          select 1
          from public.calendar_events ce
          join public.schools s on s.id = ce.school_id
          where p.id = any (ce.teacher_ids)
            and s.region = public.current_app_region()
        )
      )
    );
$$;

revoke execute on function public.report_teacher_roster(boolean) from public, anon;
grant execute on function public.report_teacher_roster(boolean) to authenticated;

-- teacher_directory(): identical fix, same shape as before (id/full_name/
-- email/phone/region) — only the Regional Manager branch's scoping changes,
-- from profiles.region to the calendar-events-based join above. No DROP
-- needed since the return columns are unchanged.

create or replace function public.teacher_directory()
returns table (
  id uuid,
  full_name text,
  email text,
  phone text,
  region public.region
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.id, p.full_name, u.email, p.phone, p.region
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
    and p.archived_at is null
    and (
      public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and exists (
          select 1
          from public.calendar_events ce
          join public.schools s on s.id = ce.school_id
          where p.id = any (ce.teacher_ids)
            and s.region = public.current_app_region()
        )
      )
    );
$$;

revoke execute on function public.teacher_directory() from public, anon;
grant execute on function public.teacher_directory() to authenticated;
