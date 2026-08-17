-- Substitute finder: who can cover a class whose teacher is out.
--
-- This moved here from the School-Visit-Planning app, where it could not work:
-- that app derives its "teachers" from the calendar event's organizer, which on
-- a school calendar is the calendar itself — so its teacher list was 53 school
-- names with no email addresses. Everything the search needs already lives
-- here: teachers with verified emails, their classes, and each class's school
-- and program.
--
-- Ranking (agreed with the Regional Manager, 2026-08-14):
--   Availability is a hard filter — anyone teaching during the window is out.
--   Then two signals of roughly equal weight, region and program:
--     2 = free, works this region, teaches this program   <- the success case
--     1 = free, and one of the two                        <- the middle, either way
--     0 = free, but neither
--
-- Ownership note: this is the Operations Manager's job. Until that role is
-- filled, Regional Managers use it too, and they need to see teachers from
-- every region — a substitute from the next region over is better than no
-- substitute. That is why this is SECURITY DEFINER: RLS deliberately scopes a
-- Regional Manager to their own region's events, and this search has to reach
-- past that. The role check below is therefore the real gate, and it lives in
-- the database rather than only in the route.

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
  if public.current_app_role() not in
     ('regional_manager', 'academic_manager', 'operations_manager', 'cpo') then
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
  -- of the classes they teach. Matches how a teacher's region is derived
  -- everywhere else in this app (see 0006's header note).
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
  -- Anyone with a class overlapping the window, including the absent teacher
  -- via the very event being covered — which is why they never suggest
  -- themselves.
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
  'Teachers who could cover the given class, free ones only, ranked by region match + program match (2 = both). Manager-gated inside the function because it deliberately reads across every region.';

-- Gated by the role check in the body, not by who can execute it.
revoke execute on function public.find_substitutes(uuid) from public, anon;
grant execute on function public.find_substitutes(uuid) to authenticated;
