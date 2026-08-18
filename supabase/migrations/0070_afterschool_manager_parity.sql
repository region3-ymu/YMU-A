-- ===========================================================================
-- 0070 — the afterschool manager gets what a Regional Manager gets
-- ===========================================================================
--
-- 0064 gave her the rows. It did not give her the four SECURITY DEFINER
-- functions that bypass RLS and re-check the region themselves, and 0065 said
-- so and left them. The visible result, reported by YMU: "Clocked in now" and
-- "Pending feedback" on her dashboard both read "Unknown teacher".
--
-- That is report_teacher_roster(). The dashboard resolves every name on the
-- page through it (see nameById in dashboard/page.tsx) and it matches on
-- s.region = current_app_region() — for a manager with no region that is no
-- rows, so every name falls through to the "Unknown teacher" default. Nothing
-- was leaking; the page just could not say who anyone was.
--
-- Her branch windows on afterschool_owned() rather than on a region, which is
-- also why it needs no school-year clause of its own: the window is already in
-- there. Note the regional_manager branches below stay UNWINDOWED, which is
-- 0061's deliberate choice — it keeps names readable on old reports.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. report_teacher_roster — the "Unknown teacher" bug
-- ---------------------------------------------------------------------------

create or replace function public.report_teacher_roster(p_include_archived boolean default false)
returns table (id uuid, full_name text, email text, phone text, archived_at timestamptz)
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
      or (
        public.current_app_role() = 'afterschool_manager'
        and exists (
          select 1
          from public.calendar_events ce
          where p.id = any (ce.teacher_ids)
            and public.afterschool_owned(ce.is_afterschool, ce.start_at)
        )
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- 2. teacher_directory — /lists, which goes back in her nav
-- ---------------------------------------------------------------------------

create or replace function public.teacher_directory()
returns table (id uuid, full_name text, email text, phone text, regions text[])
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
      or (
        public.current_app_role() = 'afterschool_manager'
        and exists (
          select 1
          from public.calendar_events ce
          where p.id = any (ce.teacher_ids)
            and ce.status <> 'cancelled'
            and public.afterschool_owned(ce.is_afterschool, ce.start_at)
        )
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- 3. assign_event_school — not parity, a hole 0064 opened
-- ---------------------------------------------------------------------------
-- An unmatched afterschool class has no school yet, so it has no region, so the
-- RM cannot see it — 0064's afterschool branch is the only one that matches it,
-- and hers is the only queue it appears in. Without this nobody could link it
-- to a school at all. She is held to afterschool classes: the school she picks
-- is unconstrained, because an unlinked event has no region to check against.

create or replace function public.assign_event_school(
  p_event_id uuid,
  p_school_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := public.current_app_role();
  v_school_region public.region;
  v_event_school_region public.region;
  v_is_afterschool boolean;
begin
  if coalesce(
    v_role in ('regional_manager', 'afterschool_manager', 'operations_manager', 'cpo'),
    false
  ) is false then
    raise exception 'only managers can assign a school to an event';
  end if;

  select region into strict v_school_region
  from public.schools where id = p_school_id;

  select s.region, public.afterschool_owned(e.is_afterschool, e.start_at)
    into v_event_school_region, v_is_afterschool
  from public.calendar_events e
  left join public.schools s on s.id = e.school_id
  where e.id = p_event_id;

  if not found then
    raise exception 'event not found';
  end if;

  if v_role = 'afterschool_manager' and not coalesce(v_is_afterschool, false) then
    raise exception 'you can only assign a school to an afterschool class';
  end if;

  if v_role = 'regional_manager' and coalesce(v_is_afterschool, false) then
    raise exception 'afterschool classes are handled by the afterschool manager';
  end if;

  -- An event without a matched school is intentionally visible to every
  -- manager as an unmatched item. Once it is matched, an RM can only alter
  -- it from within that school's region (or while the school itself remains
  -- unassigned).
  if v_role = 'regional_manager'
     and v_event_school_region is not null
     and v_event_school_region is distinct from public.current_app_region()
  then
    raise exception 'regional managers can only assign events in their own region';
  end if;

  if v_role = 'regional_manager'
     and v_school_region is not null
     and v_school_region is distinct from public.current_app_region()
  then
    raise exception 'regional managers can only assign schools in their own region';
  end if;

  update public.calendar_events
     set school_id = p_school_id,
         school_match_source = 'manual',
         school_match_score = null
   where id = p_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. find_substitutes — /substitutes, which Regional Managers have
-- ---------------------------------------------------------------------------
-- 0061's body verbatim; the only change is afterschool_manager in the role
-- guard. The candidate search is deliberately cross-region already (YMU
-- 2026-08-14: a substitute from the next region over beats no substitute), so
-- there is nothing region-shaped here to scope for her.

do $do$
declare
  v_def text;
  v_old text := $q$array['regional_manager', 'academic_manager', 'operations_manager', 'cpo']::public.app_role[]$q$;
  v_new text := $q$array['regional_manager', 'afterschool_manager', 'academic_manager', 'operations_manager', 'cpo']::public.app_role[]$q$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'find_substitutes';

  if v_def is null then
    raise exception 'find_substitutes() not found - 0060/0061 must run first';
  end if;

  -- Patch the live definition rather than restating 0061's 130-line body here.
  -- Restating it means a second copy to keep in step, and the copy that drifts
  -- is the one nobody runs. Raising on a miss is the point: if the guard is
  -- ever reworded this migration must fail loudly instead of quietly
  -- re-applying the function unchanged and leaving her locked out.
  if position(v_old in v_def) = 0 then
    if position(v_new in v_def) > 0 then
      return; -- already applied
    end if;
    raise exception 'find_substitutes() role guard has changed - re-do this patch by hand';
  end if;

  execute replace(v_def, v_old, v_new);
end
$do$;

-- resolve_calendar_issue stays (regional_manager, operations_manager, cpo).
-- It maps a whole Google calendar onto a school, which is a school-level
-- decision and not one afterschool classes have a claim on. The queue that
-- calls it is hidden from her in schedules-explorer.tsx to match.
