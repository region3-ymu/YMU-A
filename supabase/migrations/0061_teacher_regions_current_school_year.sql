-- A teacher's region(s) come from the CURRENT school year, not from all time.
--
-- The bug, reported by the Regional Manager on 2026-08-17: /lists showed
-- Central roughly 50 teachers when Central has 10. Teachers who plainly belong
-- to other regions — Jeff Joseph and Rachelle Jovane, both North — were being
-- listed as Central, and because the substitute finder derives region the same
-- way, it ranked them as same-region cover for Central classes.
--
-- The cause was one week in July. Professional development ran at Little River
-- K-8, a Central school, and nearly the whole company clocked in there:
--
--     month     events in Central   distinct teachers
--     2026-07         213                  59
--     2026-08         123                  10
--     2026-09         190                  10
--
-- A single summary, "Concert", accounts for 49 of those teachers on its own.
-- Neither teacher_directory() nor find_substitutes() bounded the calendar at
-- all, so that one week defined half the company as Central, permanently.
--
-- The fix is a lower bound on the calendar: only events from the start of the
-- current school year count toward a teacher's region. The date is read from
-- school_years, which already holds 2026-27 starting 2026-08-13 — exactly the
-- cutoff the Regional Manager asked for. Reading it rather than hardcoding it
-- means next August the Operations Manager adds the new year and the regions
-- re-derive themselves; nobody has to remember this file exists.
--
-- Not changed, deliberately:
--   * can_read_profile() (0033/0041) derives region the same way but already
--     windows its calendar clause to 1 day, so it never had this bug. Its
--     attendance_sessions clause is unbounded on purpose — that is what keeps
--     names readable on old reports, including July's PD, which really did
--     happen in Central.
--   * find_substitutes()'s `busy` CTE stays unwindowed. Availability is about
--     the class being covered, not about the school year.

-- ===========================================================================
-- 1. current_school_year_start()
-- ===========================================================================

create or replace function public.current_school_year_start()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    -- The year we are inside today. The normal case.
    (select sy.start_date
       from public.school_years sy
      where not sy.archived
        and current_date between sy.start_date and sy.end_date
      order by sy.start_date desc
      limit 1),
    -- Summer, between two years: the most recent one that has started. Last
    -- year's roster is the best answer available until the new year is added.
    (select sy.start_date
       from public.school_years sy
      where not sy.archived
        and sy.start_date <= current_date
      order by sy.start_date desc
      limit 1),
    -- No usable row at all. Degrade to the old unbounded behaviour rather than
    -- to an empty directory: too many teachers is a nuisance, none is an outage.
    '-infinity'::date
  );
$$;

comment on function public.current_school_year_start() is
  'Start date of the school year now in progress, from school_years. The lower bound for deriving a teacher''s region from their calendar. Falls back to -infinity (no window) if school_years has no usable row.';

revoke execute on function public.current_school_year_start() from public, anon;
grant execute on function public.current_school_year_start() to authenticated;

-- ===========================================================================
-- 2. teacher_directory(): regions, and the RM gate, from this year only.
-- Return shape is unchanged, so no drop needed.
-- ===========================================================================

create or replace function public.teacher_directory()
returns table (
  id uuid,
  full_name text,
  email text,
  phone text,
  regions text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.full_name,
    u.email,
    p.phone,
    coalesce((
      select array_agg(distinct s.region::text order by s.region::text)
      from public.calendar_events ce
      join public.schools s on s.id = ce.school_id
      where p.id = any (ce.teacher_ids)
        and s.region is not null
        -- Cancelled classes never meant the teacher works that region; 0021
        -- counted them.
        and ce.status <> 'cancelled'
        and ce.start_at >= public.current_school_year_start()
    ), '{}') as regions
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
    and p.archived_at is null
    and (
      public.current_app_role() in ('operations_manager', 'cpo')
      or (
        -- Same window as the regions column above: a Regional Manager sees the
        -- teachers who work their region THIS year. A teacher with no schedule
        -- yet has no region and appears only to OM/CPO, which is correct — they
        -- are not yet anyone's teacher.
        public.current_app_role() = 'regional_manager'
        and exists (
          select 1
          from public.calendar_events ce
          join public.schools s on s.id = ce.school_id
          where p.id = any (ce.teacher_ids)
            and s.region = public.current_app_region()
            and ce.status <> 'cancelled'
            and ce.start_at >= public.current_school_year_start()
        )
      )
    );
$$;

comment on function public.teacher_directory() is
  'Manager-visible teacher list. regions are derived from the schools the teacher is scheduled at during the CURRENT school year (see current_school_year_start) — NOT profiles.region, which is null-by-design for teachers, and not all-time, which let one July PD week put half the company in Central.';

revoke execute on function public.teacher_directory() from public, anon;
grant execute on function public.teacher_directory() to authenticated;

-- ===========================================================================
-- 3. find_substitutes(): same window on the coverage CTE.
-- Return shape unchanged. Only the `coverage` CTE differs from 0060.
-- ===========================================================================

create or replace function public.find_substitutes(p_event_id uuid)
returns table (
  teacher_id   uuid,
  full_name    text,
  email        text,
  phone        text,
  regions      text[],
  programs     text[],
  same_region  boolean,
  same_program boolean,
  score        integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_school_id uuid;
  v_region    public.region;
  v_start     timestamptz;
  v_end       timestamptz;
  v_program   text;
  v_year_start date := public.current_school_year_start();
begin
  -- A SECURITY DEFINER function bypasses RLS, so it decides for itself who may
  -- call it. Teachers must never reach this: it exposes the whole staff roster.
  --
  -- Phrased as a positive allow-list ending in `is not true`, not as
  -- `not in (...)`. For a caller with no profile row current_app_role() is
  -- null, and `null not in (...)` evaluates to null rather than true — so that
  -- form let the guard fall through silently and returned every teacher's name,
  -- email and phone. `is not true` makes null fail closed.
  if (public.current_app_role() = any (
        array['regional_manager', 'academic_manager', 'operations_manager', 'cpo']::public.app_role[]
      )) is not true then
    raise exception 'finding substitutes requires a manager role';
  end if;

  -- The event being covered supplies all three inputs: when, where, and what.
  -- The program is derived from the class title the same way the rest of the
  -- app does it (most specific pattern first) — it is not stored on the event.
  select e.school_id,
         e.start_at,
         e.end_at,
         (select pr.name
            from public.programs pr
           where pr.active
             and exists (
               select 1 from unnest(pr.match_patterns) mp
                where position(mp in lower(coalesce(e.summary, ''))) > 0
             )
           order by pr.sort_order
           limit 1)
    into v_school_id, v_start, v_end, v_program
    from public.calendar_events e
   where e.id = p_event_id;

  if v_school_id is null then
    raise exception 'event % not found, or not linked to a school', p_event_id;
  end if;

  select s.region into v_region from public.schools s where s.id = v_school_id;

  return query
  with teacher as (
    select p.id, p.full_name, u.email::text as email, p.phone
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.role = 'teacher'
       and p.archived_at is null
  ),
  -- What each teacher actually covers, read off their own calendar rather than
  -- stored anywhere: the regions of the schools they teach at, and the programs
  -- of the classes they teach. Windowed to the current school year, the same as
  -- teacher_directory() — without it, July's PD at a Central school made almost
  -- every teacher in the company score as same-region cover for Central.
  coverage as (
    select t.id as teacher_id,
           array_agg(distinct s.region::text) filter (where s.region is not null) as regions,
           array_agg(distinct pm.name)        filter (where pm.name  is not null) as programs
      from teacher t
      join public.calendar_events e
        on t.id = any(e.teacher_ids)
       and e.status <> 'cancelled'
       and e.start_at >= v_year_start
      left join public.schools s on s.id = e.school_id
      left join lateral (
        select pr.name
          from public.programs pr
         where pr.active
           and exists (
             select 1 from unnest(pr.match_patterns) mp
              where position(mp in lower(coalesce(e.summary, ''))) > 0
           )
         order by pr.sort_order
         limit 1
      ) pm on true
     group by t.id
  ),
  -- Anyone with a class overlapping the window, including the absent teacher
  -- via the very event being covered — which is why they never suggest
  -- themselves. Deliberately NOT year-windowed: availability is about the
  -- clock, and the class being covered may itself sit outside the year.
  busy as (
    select distinct t.id
      from teacher t
      join public.calendar_events e
        on t.id = any(e.teacher_ids)
       and e.status <> 'cancelled'
     where e.start_at < v_end
       and e.end_at   > v_start
  )
  select t.id,
         t.full_name,
         t.email,
         t.phone,
         coalesce(c.regions,  '{}'::text[]),
         coalesce(c.programs, '{}'::text[]),
         coalesce(v_region::text = any(c.regions), false),
         coalesce(v_program      = any(c.programs), false),
         (case when coalesce(v_region::text = any(c.regions),  false) then 1 else 0 end
        + case when coalesce(v_program      = any(c.programs), false) then 1 else 0 end)
    from teacher t
    left join coverage c on c.teacher_id = t.id
   where t.id not in (select id from busy)
   order by 9 desc, t.full_name;
end;
$$;

comment on function public.find_substitutes(uuid) is
  'Teachers who could cover the given class, free ones only, ranked by region match + program match (2 = both). Region and program coverage are read from the CURRENT school year (see current_school_year_start). Manager-gated inside the function because it deliberately reads across every region.';

revoke execute on function public.find_substitutes(uuid) from public, anon;
grant execute on function public.find_substitutes(uuid) to authenticated;
