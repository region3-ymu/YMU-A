-- ===========================================================================
-- 0091 — 0090 regressed 0070's afterschool_manager parity patch
-- ===========================================================================
--
-- 0090 redefined find_substitutes() by copying its role guard from 0060's
-- file on disk, which predates 0070's in-place patch adding
-- 'afterschool_manager' to the allow-list. The redefinition silently
-- reverted that patch, breaking find_substitutes() for the afterschool
-- manager (caught by tests/afterschool-rls.test.ts). Restoring it here, and
-- 0090's file on disk now carries the fix so a fresh replay doesn't
-- reintroduce this.
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
  coverage as (
    select t.id as teacher_id,
           array_agg(distinct s.region::text) filter (where s.region is not null) as regions,
           array_agg(distinct pm.name)        filter (where pm.name  is not null) as programs
      from teacher t
      join public.calendar_events e
        on t.id = any(e.teacher_ids)
       and e.status <> 'cancelled'
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
  -- which is why they never suggest themselves.
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
  'Teachers who could cover the given class — free of it, and with enough travel_minutes() to and from whatever they teach immediately before/after — ranked by region match + program match (2 = both). Manager-gated inside the function because it deliberately reads across every region, plus the afterschool manager per 0070.';
