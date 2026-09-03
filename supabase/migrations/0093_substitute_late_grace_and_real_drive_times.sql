-- ===========================================================================
-- 0093 — late is fine going INTO the substitution, never going OUT of it;
--         and prefer a real driving time over the straight-line estimate
-- ===========================================================================
--
-- Two changes, both from region3@ymu.org (2026-09-03), reviewing how
-- School-Visit-Planning-YMU already does routing (OpenRouteService, cached):
--
-- 1. 0090 treated "not enough travel time" the same on both sides of the
--    window: before AND after. YMU's actual rule is asymmetric. If the
--    candidate's PRIOR class runs them a few minutes late arriving to the
--    class they'd be covering, that's fine up to 15 minutes — "no me importa
--    que lleguen de 5-15 minutos tarde, so lo puedes mostrar ese profesor en
--    caso de." But if covering this class would make them late to whatever
--    THEY teach next, that's not tolerated at all — showing up late to their
--    own next class is a second problem, not a acceptable tradeoff.
--
--    substitute_late_minutes() computes the shortfall on the "before" side;
--    substitute_available() allows it up to 15, and find_substitutes() now
--    surfaces the number so a manager can see "might be a few minutes late"
--    before calling. The "after" side keeps 0090's strict requirement.
--
-- 2. travel_minutes() (0090) was always a straight-line-distance guess —
--    this codebase has never called a real routing API. school_travel_times
--    is a cache for actual OpenRouteService driving durations (see
--    scripts/build-school-travel-matrix.ts, added alongside this migration),
--    the same shape as School-Visit-Planning-YMU's TravelMatrixCache.
--    travel_minutes() now prefers a cached real duration and only falls back
--    to the straight-line estimate for a school pair the matrix hasn't
--    covered yet (a school added since the last build, most likely).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Cache for real driving durations between two schools
-- ---------------------------------------------------------------------------
-- Directed (school_a → school_b can differ from the reverse — one-way
-- streets, turn restrictions), same as ORS's own matrix response. Populated
-- entirely by scripts/build-school-travel-matrix.ts using the service role;
-- nothing in the app writes to it, so RLS with no policies locks it to that
-- script and to travel_minutes() below (SECURITY DEFINER).

create table if not exists public.school_travel_times (
  school_a      uuid not null references public.schools (id) on delete cascade,
  school_b      uuid not null references public.schools (id) on delete cascade,
  drive_minutes integer not null check (drive_minutes >= 0),
  distance_m    integer,
  computed_at   timestamptz not null default now(),
  primary key (school_a, school_b),
  constraint school_travel_times_not_self check (school_a <> school_b)
);

comment on table public.school_travel_times is
  'Real driving duration from school_a to school_b (directed — the reverse pair is a separate row), precomputed by scripts/build-school-travel-matrix.ts via OpenRouteService. Read by travel_minutes(), which falls back to a straight-line estimate for any pair not yet here. Re-run the script after adding a school or correcting its lat/lng.';

alter table public.school_travel_times enable row level security;

revoke all on table public.school_travel_times from anon, authenticated;
grant all on table public.school_travel_times to service_role;

-- ---------------------------------------------------------------------------
-- 2. travel_minutes() prefers the real cached duration
-- ---------------------------------------------------------------------------

create or replace function public.travel_minutes(
  p_school_a uuid,
  p_school_b uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_school_a is null or p_school_b is null then 45
    when p_school_a = p_school_b then 0
    else coalesce(
      (
        select t.drive_minutes
          from public.school_travel_times t
         where t.school_a = p_school_a and t.school_b = p_school_b
      ),
      (
        select greatest(
          15,
          (ceil(public.haversine_meters(a.lat, a.lng, b.lat, b.lng) / 1000.0 / 32.0 * 60.0) + 10)::integer
        )
          from public.schools a, public.schools b
         where a.id = p_school_a and b.id = p_school_b
           and a.lat is not null and a.lng is not null
           and b.lat is not null and b.lng is not null
      ),
      45
    )
  end;
$$;

comment on function public.travel_minutes(uuid, uuid) is
  'Minutes needed to get from one school to the other: a real OpenRouteService driving duration if school_travel_times has it, else a straight-line estimate (32 km/h + 10 min setup, floored at 15), else 45 if either school''s location is unknown. 0 for the same school.';

-- ---------------------------------------------------------------------------
-- 3. How late the nearest DIFFERENT-school class before the window would
--    make this teacher arrive — 0 if they'd be on time or early
-- ---------------------------------------------------------------------------

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
  -- max(), not a bare scalar subquery: two classes can legitimately end at
  -- the exact same instant (a shared bell schedule, or a co-taught class
  -- with two rows). A plain scalar subquery raises "more than one row
  -- returned by a subquery used as an expression" the first time that
  -- happens; max() resolves the tie by taking the more-late of the two,
  -- which is the conservative answer anyway.
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
  'Minutes this teacher would be late arriving to a class at p_school_id starting p_start, given the nearest different-school class immediately before it — 0 if they''d be on time or early, or if there is no such class. substitute_available() tolerates up to 15; find_substitutes() surfaces the number so a manager can see it before calling.';

revoke execute on function public.substitute_late_minutes(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.substitute_late_minutes(uuid, uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. substitute_available() — asymmetric now: grace going in, none going out
-- ---------------------------------------------------------------------------

create or replace function public.substitute_available(
  p_teacher_id uuid,
  p_school_id  uuid,
  p_start      timestamptz,
  p_end        timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists ( -- Hard overlap: teaching something else during the window itself.
      select 1
        from public.calendar_events e
       where p_teacher_id = any(e.teacher_ids)
         and e.status <> 'cancelled'
         and e.start_at < p_end
         and e.end_at   > p_start
    )
    -- Arriving late TO this class is tolerated up to 15 minutes (YMU,
    -- 2026-09-03). See substitute_late_minutes() above.
    and public.substitute_late_minutes(p_teacher_id, p_school_id, p_start) <= 15
    -- Being late to whatever the teacher has scheduled AFTER this class is
    -- not tolerated at all — covering this one must not create a second
    -- late arrival at a third school.
    and not exists (
      select 1
        from public.calendar_events e
       where p_teacher_id = any(e.teacher_ids)
         and e.status <> 'cancelled'
         and e.start_at >= p_end
         and e.school_id is distinct from p_school_id
         and e.start_at = (
               select min(e2.start_at)
                 from public.calendar_events e2
                where p_teacher_id = any(e2.teacher_ids)
                  and e2.status <> 'cancelled'
                  and e2.start_at >= p_end
             )
         and extract(epoch from (e.start_at - p_end)) / 60.0
               < public.travel_minutes(p_school_id, e.school_id)
    );
$$;

comment on function public.substitute_available(uuid, uuid, timestamptz, timestamptz) is
  'Whether a teacher could cover a class at p_school_id from p_start to p_end: no overlapping class, at most 15 minutes'' shortfall arriving to it from whatever they teach immediately before (see substitute_late_minutes()), and the FULL travel_minutes() to whatever they teach immediately after — no grace on that side. The single source of truth find_substitutes() and confirm_substitution() both defer to.';

-- ---------------------------------------------------------------------------
-- 5. find_substitutes() surfaces late_minutes — a shape change, so this one
--    needs the drop tests/migration-redefinitions.test.ts requires.
-- ---------------------------------------------------------------------------

drop function if exists public.find_substitutes(uuid);

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
  score        integer,
  late_minutes integer
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
  -- What each teacher actually covers TODAY: bounded by app_data_start()
  -- (0092) so a recurring series from a school they no longer teach at,
  -- swept in by the initial Google sync, can't permanently tag them into
  -- that region.
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
  -- substitute_available() (0090/0093), which also rules out a teacher who
  -- could not physically get here from (or to) whatever they teach next
  -- door, allowing up to 15 minutes' lateness arriving in but none leaving.
  -- Still catches the absent teacher via the very event being covered, which
  -- is why they never suggest themselves.
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
        + case when coalesce(v_program      = any(c.programs), false) then 1 else 0 end),
         public.substitute_late_minutes(t.id, v_school_id, v_start)
    from teacher t
    left join coverage c on c.teacher_id = t.id
   where t.id not in (select id from conflicted)
   order by 9 desc, t.full_name;
end;
$$;

comment on function public.find_substitutes(uuid) is
  'Teachers who could cover the given class — free of it (up to 15 minutes'' grace arriving late, none leaving late), and ranked by region match + program match (2 = both), both derived only from calendar_events on or after app_data_start(). late_minutes is 0 (on time) or the shortfall a manager should know about before calling. Manager-gated inside the function because it deliberately reads across every region, plus the afterschool manager per 0070.';

revoke execute on function public.find_substitutes(uuid) from public, anon;
grant execute on function public.find_substitutes(uuid) to authenticated;
