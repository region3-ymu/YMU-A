-- ===========================================================================
-- 0092 — find_substitutes()'s region/program tagging was reading 2024 history
-- ===========================================================================
--
-- Reported by region3@ymu.org: searching for a substitute in Central showed
-- basically every teacher in the region as a same-region match, most of whom
-- don't actually teach there today.
--
-- Cause: the `coverage` CTE derives a teacher's regions/programs from their
-- OWN calendar_events, with no lower bound on start_at — exactly the history
-- app_data_start() (0049) exists to keep out of everything else. 58 distinct
-- teachers have calendar_events at Little River K-8 (region: central) dated
-- November 2024-January 2025 — last year's recurring Beginning Band series,
-- swept in by the initial Google Calendar sync along with 8,496 other
-- pre-pilot events (0049's own header). Every one of those 58 teachers'
-- `coverage.regions` permanently included 'central' from that alone,
-- regardless of where they actually teach now.
--
-- find_substitutes() was written in 0060, after app_data_start() already
-- existed in 0049, and simply never picked up the bound every other
-- calendar_events-reading query in this codebase uses (0049, 0052, 0056,
-- 0077). Same column shape, so a plain create-or-replace.
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
begin
  -- A SECURITY DEFINER function bypasses RLS, so it decides for itself who may
  -- call it. Teachers must never reach this: it exposes the whole staff roster.
  -- afterschool_manager included per 0070 — do not drop it on a future
  -- create-or-replace of this function without re-checking that patch.
  if (public.current_app_role() = any (
        array['regional_manager', 'afterschool_manager', 'academic_manager', 'operations_manager', 'cpo']::public.app_role[]
      )) is not true then
    raise exception 'finding substitutes requires a manager role';
  end if;

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
  -- What each teacher actually covers TODAY: bounded by app_data_start() (0049)
  -- so a recurring series from a school they no longer teach at, swept in by
  -- the initial Google sync, can't permanently tag them into that region.
  coverage as (
    select t.id as teacher_id,
           array_agg(distinct s.region::text) filter (where s.region is not null) as regions,
           array_agg(distinct pm.name)        filter (where pm.name  is not null) as programs
      from teacher t
      join public.calendar_events e
        on t.id = any(e.teacher_ids)
       and e.status <> 'cancelled'
       and e.start_at >= public.app_data_start()
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
  -- Not just "anyone with a class overlapping the window" any more — see
  -- substitute_available() (0090), which also rules out a teacher who could
  -- not physically get here from (or to) whatever they teach next door in
  -- time. Still catches the absent teacher via the very event being covered,
  -- which is why they never suggest themselves. Deliberately NOT bounded by
  -- app_data_start(): this checks the real, current schedule around the
  -- specific class being covered, not a teacher's history.
  conflicted as (
    select t.id
      from teacher t
     where not public.substitute_available(t.id, v_school_id, v_start, v_end)
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
   where t.id not in (select id from conflicted)
   order by 9 desc, t.full_name;
end;
$$;

comment on function public.find_substitutes(uuid) is
  'Teachers who could cover the given class — free of it, and with enough travel_minutes() to and from whatever they teach immediately before/after — ranked by region match + program match (2 = both), both derived only from calendar_events on or after app_data_start(). Manager-gated inside the function because it deliberately reads across every region, plus the afterschool manager per 0070.';
