-- ===========================================================================
-- 0077 — the second class of a back-to-back run clocks itself in
-- ===========================================================================
--
-- 20 of the first 116 late_clock_in flags (17%) are on the SECOND class of a
-- run the teacher is already standing in. Kevin Bodniza teaches Music
-- Production 09:10-10:45 at Horace Mann and again at 10:50; Jose Heredia runs
-- two Band (Rotating) blocks at South Dade Middle, 11:40-13:40 then 13:45.
-- They clock in for the first one, teach for ninety minutes in the same room,
-- and get flagged for not clocking in again five minutes later. Kevin's school
-- has no usable internet, so the second clock-in is not just redundant, it is
-- often impossible.
--
-- These flags are worse than noise. Every one of them pushes a notification to
-- a Regional Manager, and a manager who dismisses twenty harmless flags a week
-- stops reading the twenty-first.
--
-- ── Why an opt-in rule and not a blanket policy ──────────────────────────
--
-- 23 back-to-back runs exist across all four regions. YMU wants it on for two
-- of them and explicitly wants NORMAL clock-in kept at Madison, Benjamin
-- Franklin and Lillie C. Evans — same shape, different judgement, because a
-- clock-in is also the only evidence the teacher was physically there. That
-- call belongs to whoever manages the region, so it lives in a table with a
-- toggle, not in this function's WHERE clause.
--
-- ── Why the rule is keyed on (school, teacher) ───────────────────────────
--
-- recurring_event_id was the obvious candidate and is the wrong one: Google
-- reissues it whenever a series is recreated, so the rule would silently stop
-- firing and nobody would notice until the flags came back. (school, teacher)
-- is also how YMU describes the cases out loud — "Kevin Bodniza en Horace
-- Mann" — which is a good sign it is the real grain.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Which runs are allowed to carry over
-- ---------------------------------------------------------------------------
-- teacher_id null means every teacher at that school. Nothing needs it today;
-- it is here because "Little River afterschool" is a property of the site's
-- schedule, not of Reinaldo, and the next such request will be site-wide.
--
-- max_gap_minutes defaults to 15 rather than the observed 10, so the Wednesday
-- bell schedule (which shifts every run by a few minutes) cannot quietly take
-- a rule out of range.

create table if not exists public.auto_clock_in_rules (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  teacher_id uuid references public.profiles (id) on delete cascade,
  max_gap_minutes integer not null default 15 check (max_gap_minutes between 0 and 60),
  active boolean not null default true,
  -- Why this rule exists, in the words of whoever asked for it. A rule that
  -- suppresses evidence of attendance should never be unexplained.
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One rule per target. A school-wide rule and a teacher-specific rule can
-- coexist; the function takes the largest gap either allows.
create unique index if not exists auto_clock_in_rules_school_teacher_idx
  on public.auto_clock_in_rules (school_id, coalesce(teacher_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on table public.auto_clock_in_rules is
  'Where a teacher already clocked into an earlier class at the same school, the next class within max_gap_minutes is recorded automatically by auto_clock_in_back_to_back(). Opt-in per (school, teacher) — a clock-in is evidence of presence, so suppressing it is a decision a manager makes, not a default.';
comment on column public.auto_clock_in_rules.teacher_id is
  'Null means every teacher at this school.';

alter table public.auto_clock_in_rules enable row level security;

-- Readable by any manager (the toggle screen has to show every region's runs,
-- the same reason find_substitutes reaches past a region), writable only by
-- the roles that already set org-wide attendance policy — the same pair that
-- may set profiles.clock_in_exempt in 0052.
create policy auto_clock_in_rules_select on public.auto_clock_in_rules
  for select to authenticated
  using (
    public.current_app_role() in ('regional_manager', 'afterschool_manager')
    or public.current_sees_all_regions()
  );

create policy auto_clock_in_rules_write on public.auto_clock_in_rules
  for all to authenticated
  using (public.current_app_role() in ('operations_manager', 'cpo'))
  with check (public.current_app_role() in ('operations_manager', 'cpo'));

create trigger auto_clock_in_rules_touch
  before update on public.auto_clock_in_rules
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. 'carryover' joins the origins
-- ---------------------------------------------------------------------------
-- Same reasoning as 0052 adding 'exempt': a session the app wrote must never
-- be mistakable for a teacher pressing the button. The Attendance tab's
-- "Clock-in origin" column already carries this straight through to YMU's
-- spreadsheet, so 'carryover' shows up there with no further work.

alter table public.attendance_sessions
  drop constraint attendance_sessions_origin_check;

alter table public.attendance_sessions
  add constraint attendance_sessions_origin_check
  check (origin in ('online', 'offline', 'admin', 'exempt', 'carryover'));

-- ---------------------------------------------------------------------------
-- 3. The runs themselves, for the toggle screen
-- ---------------------------------------------------------------------------
-- The same query that found the 23 runs, as a function, so the screen where a
-- manager turns rules on shows real evidence — gap, how many dates it repeats
-- on, how many late flags it has already produced — instead of asking them to
-- remember which teacher has two classes in a row.
--
-- Grouped by clock time, not by event, because a run repeats 41 times a term;
-- the Wednesday bell schedule produces a second row for the same run at
-- different times, which is correct — the gap really is different that day.

create or replace function public.back_to_back_runs(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  school_id uuid,
  school_name text,
  region text,
  teacher_id uuid,
  teacher_name text,
  first_class text,
  first_start time,
  first_end time,
  second_class text,
  second_start time,
  gap_minutes integer,
  is_afterschool boolean,
  occurrences bigint,
  late_flags bigint,
  rule_active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select coalesce(p_from, public.app_data_start()::timestamptz) as lo,
           coalesce(p_to, now() + interval '180 days')            as hi
  ),
  ev as (
    select e.id, t.teacher_id, e.school_id, e.summary, e.start_at, e.end_at, e.is_afterschool
      from public.calendar_events e
      cross join lateral unnest(e.teacher_ids) as t (teacher_id)
      cross join bounds b
     where e.status <> 'cancelled'
       and e.all_day = false
       and e.school_id is not null
       and e.start_at >= b.lo
       and e.start_at <  b.hi
  ),
  pairs as (
    select a.teacher_id,
           a.school_id,
           a.summary as first_class,
           b.summary as second_class,
           (a.start_at at time zone 'America/New_York')::time as first_start,
           (a.end_at   at time zone 'America/New_York')::time as first_end,
           (b.start_at at time zone 'America/New_York')::time as second_start,
           extract(epoch from (b.start_at - a.end_at)) / 60 as gap_minutes,
           a.is_afterschool or b.is_afterschool as is_afterschool,
           b.id as second_event_id
      from ev a
      join ev b
        on  a.teacher_id = b.teacher_id
        and a.school_id  = b.school_id
        and a.id <> b.id
        -- A negative lower bound on purpose: Little River's Tutoring starts
        -- five minutes BEFORE Beginning Band is scheduled to end. Overlapping
        -- is a scheduling error, but it is a real one and the teacher is still
        -- in the building.
        and b.start_at >= a.end_at - interval '5 minutes'
        and b.start_at <= a.end_at + interval '30 minutes'
        and (a.start_at at time zone 'America/New_York')::date
          = (b.start_at at time zone 'America/New_York')::date
  )
  select p.school_id,
         s.name,
         s.region::text,
         p.teacher_id,
         pr.full_name,
         p.first_class,
         p.first_start,
         p.first_end,
         p.second_class,
         p.second_start,
         round(avg(p.gap_minutes))::integer,
         bool_or(p.is_afterschool),
         count(distinct p.second_event_id),
         count(distinct f.id),
         -- A scalar subquery, NOT a join. Joining here would multiply every
         -- pair by the number of matching rules, and occurrences/late_flags
         -- are counts — a school-wide rule alongside a teacher rule would
         -- silently report 82 dates for a run that happens 41 times.
         exists (
           select 1 from public.auto_clock_in_rules r
            where r.active
              and r.school_id = p.school_id
              and (r.teacher_id is null or r.teacher_id = p.teacher_id)
         )
    from pairs p
    join public.schools s on s.id = p.school_id
    left join public.profiles pr on pr.id = p.teacher_id
    left join public.flags f
      on  f.event_id = p.second_event_id
      and f.teacher_id = p.teacher_id
      and f.type = 'late_clock_in'
   group by p.school_id, s.name, s.region, p.teacher_id, pr.full_name,
            p.first_class, p.first_start, p.first_end, p.second_class, p.second_start
   order by s.region, pr.full_name, p.first_start;
$$;

comment on function public.back_to_back_runs(timestamptz, timestamptz) is
  'Every same-teacher same-school run where the next class starts within 30 minutes of the previous one ending, with its gap, how often it repeats, how many late flags it has produced, and whether auto clock-in is on for it. Drives the toggle screen.';

revoke execute on function public.back_to_back_runs(timestamptz, timestamptz) from public, anon;
grant execute on function public.back_to_back_runs(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Recording the carried-over attendance
-- ---------------------------------------------------------------------------
-- Deliberately shaped like auto_attend_exempt_teachers() (0052): a
-- service_role sweep that inserts sessions and then closes the flags they
-- answer. Two things differ, both on purpose.
--
--   * It runs at the START of the class, not the end. The whole point is to
--     beat detect_late_clockins() to the flag, so late-detect/index.ts calls
--     this first. A flag raised and then auto-resolved has already pushed a
--     notification to a manager's phone, which is the thing being fixed.
--
--   * The session OWES FEEDBACK. An exempt teacher is exempt from the form
--     too; a teacher on a back-to-back run is not — they taught the class, and
--     the 24-hour deadline applies exactly as it would have.
--
-- The GPS is copied from the earlier session rather than left null. That is
-- the teacher's real, server-verified position inside the geofence, taken at
-- most an hour earlier at the same school. Nulls would read as "we have no
-- idea where they were", which is less true than what we do know.

create or replace function public.auto_clock_in_back_to_back()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer;
begin
  v_count := 0;

  -- A loop, not one INSERT with a data-modifying CTE. The close-then-insert
  -- order is load-bearing: attendance_one_open_session_per_teacher is a
  -- partial unique index on (teacher_id) where clock_out_at is null, so an
  -- insert that lands before its matching close fails with a raw 23505.
  -- Postgres does not define the execution order of a data-modifying CTE
  -- relative to the outer statement, and they share one snapshot, so the
  -- readable version of that query was also the unreliable one. Volumes here
  -- are a handful of rows per five-minute tick.
  for v_row in
    select distinct on (ce.id, t.teacher_id)
           ce.id           as event_id,
           t.teacher_id    as teacher_id,
           ce.school_id    as school_id,
           ce.start_at     as start_at,
           ce.end_at       as end_at,
           prev.clock_in_lat        as lat,
           prev.clock_in_lng        as lng,
           prev.clock_in_accuracy_m as accuracy_m,
           prev.clock_in_distance_m as distance_m
      from public.calendar_events ce
      cross join lateral unnest(ce.teacher_ids) as t (teacher_id)
      -- The rule. Largest max_gap_minutes wins where a school-wide and a
      -- teacher-specific rule both apply.
      join lateral (
        select max(r.max_gap_minutes) as max_gap_minutes
          from public.auto_clock_in_rules r
         where r.active
           and r.school_id = ce.school_id
           and (r.teacher_id is null or r.teacher_id = t.teacher_id)
      ) rule on rule.max_gap_minutes is not null
      -- The earlier class at the same school that the teacher DID clock into.
      -- Ordering by end_at desc picks the immediately preceding one, so a
      -- three-class run carries over one link at a time.
      join public.calendar_events prev_ce
        on  prev_ce.school_id = ce.school_id
        and t.teacher_id = any(prev_ce.teacher_ids)
        and prev_ce.status <> 'cancelled'
        and prev_ce.id <> ce.id
        and prev_ce.end_at is not null
        and prev_ce.end_at >= ce.start_at - make_interval(mins => rule.max_gap_minutes)
        and prev_ce.end_at <= ce.start_at + interval '5 minutes'
      join public.attendance_sessions prev
        on  prev.event_id = prev_ce.id
        and prev.teacher_id = t.teacher_id
     where ce.status <> 'cancelled'
       and ce.all_day = false
       and ce.school_id is not null
       and ce.start_at is not null
       -- The class has started. No grace period: waiting even a minute would
       -- lose the race with detect_late_clockins(), and the teacher's presence
       -- is already established by the earlier session.
       and ce.start_at <= now()
       -- Same 30-minute lookback detect_late_clockins uses, for the same
       -- reason: this is a sweep on a short interval, not a backfill.
       and ce.start_at > now() - interval '30 minutes'
       and not exists (
         select 1 from public.attendance_sessions a
          where a.event_id = ce.id and a.teacher_id = t.teacher_id
       )
       -- An exempt teacher is handled end-of-class by 0052; two mechanisms
       -- writing the same session would race on the (event, teacher) pair.
       and not exists (
         select 1 from public.profiles p
          where p.id = t.teacher_id and (p.clock_in_exempt or p.archived_at is not null)
       )
     order by ce.id, t.teacher_id, prev_ce.end_at desc
  loop
    -- Close whatever the teacher still has open. This is what clock_in() does
    -- before its own insert (0026) and the least() clamp is 0026's too — an
    -- auto-close must never invent hours past the end of the class it closes.
    update public.attendance_sessions a
       set clock_out_at = least(v_row.start_at, coalesce(a.scheduled_end_at, v_row.start_at)),
           clock_out_source = 'auto_next_clock_in'
     where a.teacher_id = v_row.teacher_id
       and a.clock_out_at is null;

    insert into public.attendance_sessions (
      teacher_id, event_id, school_id,
      clock_in_at, clock_in_status,
      clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
      scheduled_start_at, scheduled_end_at, feedback_due_at,
      origin
    )
    values (
      v_row.teacher_id, v_row.event_id, v_row.school_id,
      -- The scheduled start, not now(). The teacher is not late; the app
      -- decided not to ask them again.
      v_row.start_at, 'on_time',
      v_row.lat, v_row.lng, v_row.accuracy_m, v_row.distance_m,
      v_row.start_at, v_row.end_at,
      case when v_row.end_at is null then null else v_row.end_at + interval '24 hours' end,
      'carryover'
    );

    v_count := v_count + 1;
  end loop;

  -- Belt and braces. This function is called before detect_late_clockins() so
  -- the flag should never exist — but a manual invocation, a missed cron tick,
  -- or a rule switched on mid-morning can all leave one standing, and a flag
  -- whose answer is already recorded should not sit on a manager's screen.
  update public.flags f
     set resolved_at = now(),
         details = coalesce(f.details, '{}'::jsonb)
           || jsonb_build_object('auto_resolved_by', 'back_to_back')
    from public.attendance_sessions a
   where f.type = 'late_clock_in'
     and f.resolved_at is null
     and a.origin = 'carryover'
     and a.event_id = f.event_id
     and a.teacher_id = f.teacher_id;

  return v_count;
end;
$$;

comment on function public.auto_clock_in_back_to_back() is
  'Records attendance for the next class in a back-to-back run at a school with an active auto_clock_in_rules row, when the teacher already clocked into the earlier class. origin=carryover, status=on_time, GPS copied from the earlier session, feedback still owed. Must run BEFORE detect_late_clockins() so the flag is never raised.';

revoke execute on function public.auto_clock_in_back_to_back() from public, anon, authenticated;
grant execute on function public.auto_clock_in_back_to_back() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Do not chase what is about to be recorded
-- ---------------------------------------------------------------------------
-- The ordering in late-detect/index.ts is the primary guard. This is the
-- second one, for the case the two ever drift apart: a class covered by an
-- active rule, where the teacher clocked into the preceding class, is not a
-- missing clock-in. Same shape as 0052's clock_in_exempt exclusion.
--
-- Body is 0052's verbatim apart from the added `not exists`.

create or replace function public.detect_late_clockins()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_flag record;
  v_recipient uuid;
  v_count integer := 0;
begin
  for v_flag in
    insert into public.flags (type, event_id, teacher_id, school_id, details)
    select
      'late_clock_in', ce.id, t.teacher_id, ce.school_id,
      jsonb_build_object('scheduled_start_at', ce.start_at, 'summary', ce.summary)
    from public.calendar_events ce
    cross join lateral unnest(ce.teacher_ids) as t (teacher_id)
    where ce.status <> 'cancelled'
      and ce.all_day = false
      and ce.start_at is not null
      and ce.start_at + interval '5 minutes' <= now()
      and ce.start_at + interval '5 minutes' > now() - interval '30 minutes'
      and not exists (
        select 1 from public.attendance_sessions a
        where a.event_id = ce.id and a.teacher_id = t.teacher_id
      )
      and not exists (
        select 1 from public.flags f
        where f.type = 'late_clock_in' and f.event_id = ce.id and f.teacher_id = t.teacher_id
      )
      and not exists (
        select 1 from public.profiles p
        where p.id = t.teacher_id and p.clock_in_exempt
      )
      -- Added in 0077: an active carryover rule plus a clock-in on the
      -- immediately preceding class at the same school means the teacher is
      -- already accounted for.
      and not exists (
        select 1
          from public.auto_clock_in_rules r
          join public.calendar_events prev_ce
            on  prev_ce.school_id = ce.school_id
            and t.teacher_id = any(prev_ce.teacher_ids)
            and prev_ce.status <> 'cancelled'
            and prev_ce.id <> ce.id
            and prev_ce.end_at is not null
            and prev_ce.end_at >= ce.start_at - make_interval(mins => r.max_gap_minutes)
            and prev_ce.end_at <= ce.start_at + interval '5 minutes'
          join public.attendance_sessions prev
            on prev.event_id = prev_ce.id and prev.teacher_id = t.teacher_id
         where r.active
           and r.school_id = ce.school_id
           and (r.teacher_id is null or r.teacher_id = t.teacher_id)
      )
    returning id, event_id, teacher_id, school_id
  loop
    v_count := v_count + 1;
    for v_recipient in select * from public.notify_recipients_for_school(v_flag.school_id) loop
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_recipient,
        v_flag.event_id,
        'late_clock_in',
        public.manager_notification_payload(v_flag.teacher_id, v_flag.school_id, v_flag.event_id)
          || jsonb_build_object('flag_id', v_flag.id)
      );
    end loop;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The two runs YMU asked for, and only those two
-- ---------------------------------------------------------------------------
-- Kevin Bodniza at Horace Mann (no usable internet at the school) and Jose
-- Heredia at South Dade Middle. The other 21 detected runs get a toggle on the
-- schedules screen and stay off until a manager decides — including Carol City
-- and Little River, which YMU is still asking about.
--
-- Matched by name rather than hardcoded uuid so this migration is replayable
-- against a fresh database. Silently inserts nothing if a name does not
-- resolve, which is the right failure: a seed is not the place to abort a
-- deploy, and back_to_back_runs() will show the rule as off.

insert into public.auto_clock_in_rules (school_id, teacher_id, max_gap_minutes, note)
select s.id, p.id, 15, v.note
  from (values
    ('Horace Mann Middle School', 'Kevin Bodniza',
     'No usable internet at the school; the 10:50 Music Production block follows the 09:10 one in the same room. YMU 2026-08-21.'),
    ('South Dade Middle School', 'Jose Heredia',
     'Two Band (Rotating) blocks back to back, 5 minutes apart, same room. YMU 2026-08-21.')
  ) as v (school_name, teacher_name, note)
  join public.schools s on s.name = v.school_name
  join public.profiles p on p.full_name = v.teacher_name and p.archived_at is null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 7. Turning a run on or off
-- ---------------------------------------------------------------------------
-- The RLS policy above already permits the write, so this function is not
-- about authorization — it is about the two things a raw upsert from the
-- client would get wrong: stamping created_by from auth.uid(), and treating
-- "off" as active=false rather than a delete, so a rule that gets switched off
-- keeps the note explaining why it was ever on.

create or replace function public.set_auto_clock_in_rule(
  p_school_id       uuid,
  p_teacher_id      uuid,
  p_active          boolean,
  p_max_gap_minutes integer default 15,
  p_note            text default null
)
returns public.auto_clock_in_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.auto_clock_in_rules;
begin
  if v_uid is null or public.current_app_role() not in ('operations_manager', 'cpo') then
    raise exception 'Only the operations manager or the CPO can change auto clock-in.';
  end if;
  if not exists (select 1 from public.schools s where s.id = p_school_id) then
    raise exception 'School not found.';
  end if;
  if p_teacher_id is not null and not exists (
    select 1 from public.profiles p where p.id = p_teacher_id and p.role = 'teacher'
  ) then
    raise exception 'Teacher not found.';
  end if;

  insert into public.auto_clock_in_rules (
    school_id, teacher_id, max_gap_minutes, active, note, created_by
  )
  values (
    p_school_id, p_teacher_id, coalesce(p_max_gap_minutes, 15), p_active,
    nullif(btrim(coalesce(p_note, '')), ''), v_uid
  )
  on conflict (school_id, coalesce(teacher_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set
    active          = excluded.active,
    max_gap_minutes = excluded.max_gap_minutes,
    -- coalesce, not excluded.note: switching a rule off from the toggle sends
    -- no note, and losing the original justification is how a rule becomes
    -- unexplained.
    note            = coalesce(excluded.note, auto_clock_in_rules.note)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_auto_clock_in_rule(uuid, uuid, boolean, integer, text) is
  'Creates or updates the auto clock-in rule for a (school, teacher) pair. Switching off sets active=false rather than deleting, so the note survives.';

revoke execute on function public.set_auto_clock_in_rule(uuid, uuid, boolean, integer, text) from public, anon;
grant execute on function public.set_auto_clock_in_rule(uuid, uuid, boolean, integer, text) to authenticated;
