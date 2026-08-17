-- A one-tap demo: give the demo teacher a class that is happening right now.
--
-- Pedro needs to walk somebody through the whole workflow — clock in, GPS
-- checks, class feedback, a ticket — from both sides. That needs a class that
-- is in progress at the moment of the demo, and there is no way to arrange one
-- from a real school calendar on demand.
--
-- Two things would otherwise make a live demo impossible:
--
--   1. THE GEOFENCE. clock_in() refuses a clock-in more than
--      geofence_radius_m from the school. A demo happens at the office, not at
--      a school, so the demo site is centred on the office with a 60 km radius
--      — county-wide, so a demo works from anywhere in Miami-Dade, but still a
--      real geofence rather than a disabled one.
--   2. SAME-DAY DUPLICATES. clock_in() rejects a second session for the same
--      class, so a second demo an hour later would dead-end. Every press
--      therefore clears the previous demo's class and session first.
--
-- Deliberately NOT a fake teacher inside a real school: the demo site is its
-- own school with no region, so it never appears in a Regional Manager's
-- dashboard, reports, or ticket routing.

-- ---------------------------------------------------------------------------
-- The demo site
-- ---------------------------------------------------------------------------

insert into public.schools (name, address, lat, lng, geocode_source, geofence_radius_m, region, contact_name)
select
  'YMU Demo Site',
  'Demo only — not a real school',
  -- Centred on the YMU office (the same coordinates scripts/office-test-setup.ts
  -- uses). Coordinates are required, not optional: clock_in() rejects a school
  -- with no saved location BEFORE it ever looks at the radius, so a demo site
  -- without them fails with "this school has no saved location yet" however
  -- large the radius is.
  25.80310681403, -80.222753138908, 'manual',
  -- 60 km from the office: Miami-Dade, not the planet. Measured rather than
  -- guessed — the furthest of the 110 real schools is Florida City Elementary
  -- at 47.1 km, so this covers everywhere YMU works with room to spare while
  -- still being a real geofence. A demo from anywhere in the county works; a
  -- clock-in from another state does not.
  60000,
  null,
  'Demo'
where not exists (select 1 from public.schools where name = 'YMU Demo Site');

comment on column public.schools.geofence_radius_m is
  'Metres a teacher may be from the school and still clock in. Default 200. "YMU Demo Site" is the one exception at 60 km, centred on the YMU office, so a demo works anywhere in Miami-Dade.';

-- ---------------------------------------------------------------------------
-- Provisioning a demo shift
-- ---------------------------------------------------------------------------

create or replace function public.start_demo_shift()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := public.current_app_role();
  v_school public.schools;
  v_teacher_id uuid;
  v_event_id uuid;
  v_start timestamptz;
  v_end timestamptz;
begin
  -- OM/CPO only. This writes a calendar row and deletes attendance, which is
  -- not something a Regional Manager should be able to do to demo data others
  -- may be mid-demo with.
  if v_role not in ('operations_manager', 'cpo') then
    raise exception 'Only an operations manager or the CPO can start a demo.';
  end if;

  select * into v_school from public.schools where name = 'YMU Demo Site';
  if not found then
    raise exception 'The demo site is missing. Re-run migration 0056.';
  end if;

  select p.id into v_teacher_id
  from public.profiles p
  join auth.users u on u.id = p.id
  where u.email = 'teacher@ymu.org'
  limit 1;
  if v_teacher_id is null then
    raise exception 'The demo teacher account (teacher@ymu.org) does not exist yet.';
  end if;

  -- Started five minutes ago so the clock-in is immediately live and lands as
  -- 'on_time' (clock_in()'s grace is 15 minutes), and long enough that the
  -- five GPS checks at +5/10/15/20/25 all fall inside the class.
  v_start := now() - interval '5 minutes';
  v_end := now() + interval '55 minutes';

  -- Clear the previous demo so this is repeatable. Only ever touches classes
  -- at the demo site, so no real attendance can be caught by this.
  delete from public.attendance_sessions a
   using public.calendar_events ce
   where a.event_id = ce.id and ce.school_id = v_school.id;
  delete from public.calendar_events where school_id = v_school.id;

  insert into public.calendar_events (
    calendar_id, google_event_id, summary, description, location_raw,
    start_at, end_at, all_day, status,
    attendees, teacher_ids, school_id, school_match_source, synced_at
  )
  values (
    'demo@ymu.org',
    'demo-' || extract(epoch from now())::bigint::text,
    'Demo Class — Modern Band',
    'Created by the Demo button. Safe to ignore.',
    'YMU Demo Site',
    v_start, v_end, false, 'confirmed',
    '[]'::jsonb, array[v_teacher_id], v_school.id, 'manual', now()
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'event_id', v_event_id,
    'teacher_email', 'teacher@ymu.org',
    'school', v_school.name,
    'start_at', v_start,
    'end_at', v_end
  );
end;
$$;

comment on function public.start_demo_shift() is
  'Gives the demo teacher (teacher@ymu.org) a class in progress right now at YMU Demo Site, clearing any previous demo first so it is repeatable. OM/CPO only.';

revoke execute on function public.start_demo_shift() from public, anon;
grant execute on function public.start_demo_shift() to authenticated;

-- ---------------------------------------------------------------------------
-- Keeping the demo out of the real numbers
-- ---------------------------------------------------------------------------
-- attendance_period_rows feeds Reports and the dashboard. A demo class must
-- not land in either, or every demo inflates somebody's attendance rate.
-- Everything else in the definition is unchanged from 0049.

create or replace view public.attendance_period_rows
with (security_invoker = true) as
  select
    ce.id as event_id,
    t.teacher_id,
    ce.school_id,
    s.region as school_region,
    ce.summary,
    ce.start_at,
    ce.end_at,
    asn.id as session_id,
    asn.clock_in_status,
    asn.clock_in_at,
    asn.clock_out_at,
    asn.origin,
    case
      when asn.id is not null then asn.clock_in_status
      when ce.end_at is not null and ce.end_at < now() then 'missed'
      else 'upcoming'
    end as attendance_status,
    case
      when asn.id is not null and ce.start_at is not null and ce.end_at is not null
      then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
      else null::numeric
    end as hours_worked
  from public.calendar_events ce
  join lateral unnest(ce.teacher_ids) as t(teacher_id) on true
  join public.schools s on s.id = ce.school_id
  left join public.attendance_sessions asn
    on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
  where ce.status <> 'cancelled'
    and ce.school_id is not null
    and ce.all_day = false
    and ce.start_at >= public.app_data_start()
    -- The demo site never counts as real work.
    and s.name <> 'YMU Demo Site'
    and (
      t.teacher_id = auth.uid()
      or public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and s.region = public.current_app_region()
      )
    );

comment on view public.attendance_period_rows is
  'One row per (class, teacher) with its attendance status and scheduled hours, bounded below by app_data_start() and excluding YMU Demo Site. security_invoker — the WHERE clause is the authorization.';

grant select on public.attendance_period_rows to authenticated;
