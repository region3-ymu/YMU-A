-- ===========================================================================
-- 0090 — a substitute needs time to get there, not just an empty calendar
-- ===========================================================================
--
-- find_substitutes() (0060) and confirm_substitution()'s re-check (0079) both
-- treat a teacher as free the instant their calendar has no OVERLAPPING
-- class. That is not the same thing as being able to cover the class.
--
-- Real case, Madison Middle School: Drumline I runs 12:55-2:20pm, Beginning
-- Band 2:25-3:50pm. find_substitutes() offered Rachelle Jovane for Drumline
-- I. Rachelle teaches Beginning Band at Norland Middle School every day
-- starting at 2:20pm — a different school, ~7 miles away. Her class starts
-- the exact minute Madison's Drumline I ends, so `e.start_at < v_end`
-- (2:20 < 2:20) is false and she reads as free. She cannot be in two
-- buildings at once; a strict-overlap check has no way to know that.
--
-- The fix: availability now also looks at the class immediately before and
-- immediately after the window being covered, and — when that neighboring
-- class is at a DIFFERENT school — requires enough real time between the two
-- to travel there, not just a non-negative gap.
--
-- Only the immediately-adjacent class on each side matters: any class
-- further back (or further ahead) has strictly more elapsed time than the
-- nearest one, so if the nearest one clears the travel requirement,
-- everything past it does too.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. How long it takes to get from one school to the other
-- ---------------------------------------------------------------------------
-- No drive-time API is wired up anywhere in this codebase, so this is a
-- deliberately rough estimate from straight-line distance: 32 km/h (~20 mph)
-- average, which accounts for arterial roads and lights rather than highway
-- speed, plus a flat 10 minutes to park, walk in, and get the room set up.
-- Floored at 15 minutes even for schools next door to each other — packing
-- up one classroom and getting into another building is never instant.
--
-- Same school is always 0. Unknown location (a school missing lat/lng, or an
-- event with no school_id) falls back to 45 minutes: treating an unmeasured
-- gap as generous is how an impossible substitution sneaks through, and
-- treating it as tight just holds back an occasional close-but-fine
-- candidate for a human to double check — the safer failure of the two.

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
  'Rough minutes needed to get from one school to the other: straight-line distance at 32 km/h plus 10 minutes to park and get set up, floored at 15 for any two different schools. 0 for the same school, 45 when either school''s location is unknown.';

revoke execute on function public.travel_minutes(uuid, uuid) from public, anon;
grant execute on function public.travel_minutes(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Is this teacher actually available for this class?
-- ---------------------------------------------------------------------------
-- One predicate, two callers (find_substitutes and confirm_substitution) —
-- same reasoning as auto_clock_in_rule_gap() in 0077: two hand-rolled copies
-- of "is this teacher free" is two chances for them to disagree about what
-- free means.

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
  select not exists (
    -- Hard overlap: teaching something else during the window itself.
    select 1
      from public.calendar_events e
     where p_teacher_id = any(e.teacher_ids)
       and e.status <> 'cancelled'
       and e.start_at < p_end
       and e.end_at   > p_start
  )
  and not exists (
    -- The nearest class ending at or before the window starts. If it's at a
    -- different school, the gap has to cover the trip, not just be >= 0.
    select 1
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
           )
       and extract(epoch from (p_start - e.end_at)) / 60.0
             < public.travel_minutes(e.school_id, p_school_id)
  )
  and not exists (
    -- Same idea, forward: the nearest class starting at or after the window
    -- ends.
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
  'Whether a teacher could actually cover a class at p_school_id from p_start to p_end: no overlapping class, and enough travel_minutes() between it and whichever class immediately precedes or follows it at a different school. The single source of truth find_substitutes() and confirm_substitution() both defer to.';

revoke execute on function public.substitute_available(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.substitute_available(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. find_substitutes() defers to it. Same column shape as 0060/0061, so this
--    is a legal create-or-replace with no drop needed (see
--    tests/migration-redefinitions.test.ts).
-- ---------------------------------------------------------------------------

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
  -- substitute_available() above, which also rules out a teacher who could
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
  'Teachers who could cover the given class — free of it, and with enough travel_minutes() to and from whatever they teach immediately before/after — ranked by region match + program match (2 = both). Manager-gated inside the function because it deliberately reads across every region.';

-- ---------------------------------------------------------------------------
-- 4. confirm_substitution()'s re-check defers to the same predicate. Returns
--    a row type (public.substitutions), not a table shape, so this is a
--    plain create-or-replace either way.
-- ---------------------------------------------------------------------------

create or replace function public.confirm_substitution(
  p_event_id       uuid,
  p_absent_teacher uuid,
  p_substitute     uuid,
  p_reason         text,
  p_reason_notes   text default null
)
returns public.substitutions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_role  public.app_role := public.current_app_role();
  v_event public.calendar_events;
  v_row   public.substitutions;
  v_school_region public.region;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if (v_role = any (array[
        'regional_manager', 'afterschool_manager', 'academic_manager',
        'operations_manager', 'administrator', 'cpo'
      ]::public.app_role[])) is not true then
    raise exception 'Confirming a substitute requires a manager role.';
  end if;
  if public.absence_reason_label(p_reason) is null then
    raise exception 'Choose a reason the teacher is away. "%" is not one of them.', coalesce(p_reason, '');
  end if;
  if p_reason = 'other' and nullif(btrim(coalesce(p_reason_notes, '')), '') is null then
    raise exception 'Choosing "Other" means writing why they are away.';
  end if;

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'Class not found.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'That class is cancelled — it does not need covering.';
  end if;
  if not (p_absent_teacher = any(coalesce(v_event.teacher_ids, '{}'::uuid[]))) then
    raise exception 'That teacher is not assigned to this class.';
  end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = p_substitute and p.role = 'teacher' and p.archived_at is null
  ) then
    raise exception 'The substitute must be an active teacher.';
  end if;

  -- Region and afterschool scoping, on the class.
  if v_role = 'regional_manager' then
    if public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_event.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only arrange cover for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager'
    and not public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
    raise exception 'You can only arrange cover on afterschool classes.';
  end if;

  -- The availability check that find_substitutes() applies, re-applied here.
  -- Minutes can pass between reading that list and clicking Confirm, and the
  -- one thing that must not happen is a substitute double-booked into two
  -- classes at once — or asked to teleport between two schools.
  if not public.substitute_available(p_substitute, v_event.school_id, v_event.start_at, v_event.end_at) then
    raise exception 'That teacher is not available for this class — they are either teaching then, or would not have enough time to travel from or to another school.';
  end if;

  -- Supersede rather than reject. A manager changing their mind about who
  -- covers a class should not have to find and cancel the old row first, and
  -- the old row is worth keeping.
  update public.substitutions
     set status = 'cancelled',
         cancelled_by = v_uid,
         cancelled_at = now(),
         cancel_reason = 'Superseded by a later substitution'
   where event_id = p_event_id
     and absent_teacher_id = p_absent_teacher
     and status = 'confirmed';

  insert into public.substitutions (
    event_id, school_id, absent_teacher_id, substitute_teacher_id,
    reason, reason_notes, status, confirmed_by, created_by
  )
  values (
    p_event_id, v_event.school_id, p_absent_teacher, p_substitute,
    p_reason, nullif(btrim(coalesce(p_reason_notes, '')), ''),
    'confirmed', v_uid, v_uid
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.confirm_substitution(uuid, uuid, uuid, text, text) is
  'Records that one teacher is covering another''s class, and why the assigned teacher is away. Re-checks the substitute is still available via substitute_available() — find_substitutes() ranked them minutes earlier. Supersedes any existing confirmed substitution for the same (class, absent teacher).';

revoke execute on function public.confirm_substitution(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.confirm_substitution(uuid, uuid, uuid, text, text) to authenticated;
