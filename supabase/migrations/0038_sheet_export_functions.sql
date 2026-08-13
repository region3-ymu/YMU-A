-- Everything else the spreadsheet needs: attendance, tickets, flags.
--
-- Requested by YMU's Academic Manager: all the app's data in one spreadsheet,
-- a tab per thing, so questions like "which schools have the most late
-- clock-ins in North this term" can be answered with a pivot table instead of
-- a code change.
--
-- Three functions, all in the mould of feedback_for_sheet() (0032): every name
-- and label resolved HERE, in SQL, so the TypeScript exporter stays a dumb
-- pipe that maps keys to columns and never has to know what a region is.
-- Times rendered in America/New_York, because a spreadsheet has no session
-- time zone and UTC timestamps in a school-hours report are a trap.
--
-- service_role only, for the same reason as feedback_for_sheet: these rows
-- carry every teacher's name across every region, and there is no per-row
-- authorization to apply once the data is sitting in a Google Sheet. Access
-- control moves to who the spreadsheet is shared with.
--
-- Unlike the feedback export, these are read WHOLE and written over the top of
-- the tab each run — no watermark. See the header of sheet-tabs.ts for why:
-- these rows mutate, so an append-only mirror of them is wrong within minutes.

-- ===========================================================================
-- 1. Attendance
--
-- This function has to exist; it is not a convenience wrapper.
-- attendance_period_rows carries its own auth.uid()-based WHERE clause rather
-- than relying on RLS (deliberately — the view unnests teacher_ids, and
-- row-level RLS on calendar_events cannot scope an array element). Under
-- service_role auth.uid() is NULL and current_app_role() is NULL, so every
-- branch of that predicate is false and the view returns ZERO ROWS. A cron
-- export reading it directly would silently mirror an empty tab.
-- ===========================================================================

create or replace function public.attendance_for_sheet(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  event_id uuid,
  session_id uuid,
  class_date date,
  class_time text,
  class_title text,
  program text,
  teacher_name text,
  teacher_email text,
  school_name text,
  region text,
  regional_manager text,
  attendance_status text,
  clock_in_at timestamptz,
  clock_in_minutes_late integer,
  clock_out_at timestamptz,
  clock_out_source text,
  hours_worked numeric,
  clock_in_origin text,
  distance_m integer,
  feedback_submitted text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ce.id,
    asn.id,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    ce.summary,
    -- The program is derived from the class title by the app, not stored on
    -- the event, so it is matched here the same way: most specific first.
    (select pr.name from public.programs pr
      where pr.active
        and exists (
          select 1 from unnest(pr.match_patterns) mp
           where position(mp in lower(coalesce(ce.summary, ''))) > 0
        )
      order by pr.sort_order
      limit 1),
    p.full_name,
    u.email::text,
    s.name,
    s.region::text,
    (select rm.full_name from public.profiles rm
      where rm.role = 'regional_manager' and rm.region = s.region and rm.archived_at is null
      order by rm.created_at limit 1),
    case
      when asn.id is not null then asn.clock_in_status
      when ce.end_at is not null and ce.end_at < now() then 'missed'
      else 'upcoming'
    end,
    asn.clock_in_at,
    -- Minutes late as a NUMBER, not a badge: the whole point of the sheet is
    -- that "average lateness by school" should be one AVERAGEIF away.
    case
      when asn.clock_in_at is not null and ce.start_at is not null and asn.clock_in_at > ce.start_at
      then (extract(epoch from (asn.clock_in_at - ce.start_at)) / 60)::integer
    end,
    asn.clock_out_at,
    asn.clock_out_source,
    -- Scheduled length, credited once clocked in — identical to
    -- attendance_period_rows, deliberately: two numbers called "hours worked"
    -- that disagree is worse than either being wrong.
    case
      when asn.id is not null and ce.start_at is not null and ce.end_at is not null
      then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
    end,
    asn.origin,
    asn.clock_in_distance_m::integer,
    case when asn.feedback_settled_at is not null then 'Yes'
         when asn.id is not null then 'No'
    end
  from public.calendar_events ce
  join lateral unnest(ce.teacher_ids) as t (teacher_id) on true
  join public.schools s on s.id = ce.school_id
  join public.profiles p on p.id = t.teacher_id
  left join auth.users u on u.id = t.teacher_id
  left join public.attendance_sessions asn
    on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
  where ce.status <> 'cancelled'
    and ce.school_id is not null
    and ce.all_day = false
    and (p_from is null or ce.start_at >= p_from)
    and (p_to is null or ce.start_at < p_to)
  order by ce.start_at, s.name, p.full_name;
$$;

comment on function public.attendance_for_sheet(timestamptz, timestamptz) is
  'Every scheduled class x teacher, with what actually happened. SECURITY DEFINER because attendance_period_rows is auth.uid()-scoped and returns nothing under service_role.';

revoke execute on function public.attendance_for_sheet(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.attendance_for_sheet(timestamptz, timestamptz) to service_role;

-- ===========================================================================
-- 2. Tickets
--
-- Over public.ticket_sla, which already computes FRT, effective resolution
-- time and the on_track/warning/breached verdict. Reusing it rather than
-- recomputing means the spreadsheet and the /tickets screen can never
-- disagree about whether something breached — PRD 4.3 requires exactly that.
-- ===========================================================================

create or replace function public.tickets_for_sheet()
returns table (
  ticket_number integer,
  created_date date,
  created_time text,
  status text,
  category text,
  issue_type text,
  priority text,
  teacher_name text,
  school_name text,
  region text,
  assigned_to text,
  description text,
  root_cause text,
  sla_state text,
  target_hours integer,
  first_response_minutes integer,
  awaiting_response_minutes integer,
  effective_resolution_minutes integer,
  paused_minutes integer,
  reopen_count integer,
  unanswered_overdue text,
  resolved_at timestamptz,
  closed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    v.ticket_number,
    (v.created_at at time zone 'America/New_York')::date,
    to_char(v.created_at at time zone 'America/New_York', 'HH12:MI AM'),
    v.status,
    v.category_type,
    -- Same slug-to-label mapping the feedback export uses. Kept in step by
    -- hand; both exist because the form stores slugs and a reader wants words.
    case tk.issue_subcategory
      when 'attendance'  then 'Attendance / missing students'
      when 'behavior'    then 'Student behavior & management'
      when 'instruments' then 'Damaged / missing instruments'
      when 'facilities'  then 'Tech, connectivity or facilities'
      when 'cancelled'   then 'Class cancelled on site'
      when 'repertoire'  then 'Repertoire difficulty / sheet music'
      when 'coaching'    then 'Pedagogical support & coaching'
      when 'technique'   then 'Technique / literacy barriers'
      else tk.issue_subcategory
    end,
    v.priority_level,
    p.full_name,
    s.name,
    v.region::text,
    agent.full_name,
    tk.description,
    v.root_cause_category,
    v.sla_state,
    v.ttr_target_hours,
    v.frt_minutes,
    v.awaiting_response_minutes,
    v.effective_ttr_minutes,
    v.paused_minutes,
    v.reopen_count,
    case when v.unanswered_overdue then 'Yes' else 'No' end,
    v.resolved_at,
    v.closed_at
  from public.ticket_sla v
  -- ticket_sla is the SLA maths only; the free-text description and the
  -- issue slug live on the table itself.
  join public.tickets tk on tk.id = v.id
  left join public.profiles p on p.id = v.teacher_id
  left join public.schools s on s.id = v.school_id
  left join public.profiles agent on agent.id = v.assigned_agent_id
  order by v.ticket_number;
$$;

comment on function public.tickets_for_sheet() is
  'Every ticket with its live SLA verdict. The Tickets tab is the source of truth for ticket state - the Feedback tab captures it at submission and never revisits it.';

revoke execute on function public.tickets_for_sheet() from public, anon, authenticated;
grant execute on function public.tickets_for_sheet() to service_role;

-- ===========================================================================
-- 3. Flags
-- ===========================================================================

create or replace function public.flags_for_sheet()
returns table (
  raised_date date,
  raised_time text,
  flag_type text,
  teacher_name text,
  school_name text,
  region text,
  class_title text,
  class_date date,
  status text,
  resolved_at timestamptz,
  resolved_by text,
  resolution_notes text,
  distance_m integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (f.created_at at time zone 'America/New_York')::date,
    to_char(f.created_at at time zone 'America/New_York', 'HH12:MI AM'),
    case f.type
      when 'gps_out_of_fence'  then 'Left the school geofence'
      when 'late_clock_in'     then 'Late clock-in'
      when 'feedback_stuck'    then 'Feedback overdue'
      when 'ticket_unassigned' then 'Ticket with no owner'
      else f.type
    end,
    p.full_name,
    s.name,
    s.region::text,
    ce.summary,
    (ce.start_at at time zone 'America/New_York')::date,
    case when f.resolved_at is null then 'Open' else 'Resolved' end,
    f.resolved_at,
    resolver.full_name,
    f.details->>'resolution_notes',
    (f.details->>'distance_m')::integer
  from public.flags f
  left join public.profiles p on p.id = f.teacher_id
  left join public.schools s on s.id = f.school_id
  left join public.calendar_events ce on ce.id = f.event_id
  left join public.profiles resolver on resolver.id = f.resolved_by
  order by f.created_at desc;
$$;

comment on function public.flags_for_sheet() is
  'GPS, late clock-in and feedback escalations, open and resolved.';

revoke execute on function public.flags_for_sheet() from public, anon, authenticated;
grant execute on function public.flags_for_sheet() to service_role;

-- ===========================================================================
-- 4. Reference lists
--
-- Small, and the reason the fact tabs above can stay narrow: with these in the
-- spreadsheet, any fact tab can be grouped by region, level or program with an
-- XLOOKUP instead of us pre-joining every combination anyone might want.
-- ===========================================================================

create or replace function public.schools_for_sheet()
returns table (
  school_name text,
  region text,
  address text,
  has_coordinates text,
  geofence_radius_m integer,
  has_calendar text,
  classes_this_year integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.name,
    s.region::text,
    s.address,
    case when s.lat is null or s.lng is null then 'NO - cannot clock in' else 'Yes' end,
    s.geofence_radius_m,
    case when s.google_calendar_id is null then 'No' else 'Yes' end,
    (select count(*)::integer from public.calendar_events ce
      where ce.school_id = s.id and ce.status = 'confirmed'
        and ce.start_at >= date_trunc('year', now()) - interval '6 months')
  from public.schools s
  order by s.region::text, s.name;
$$;

revoke execute on function public.schools_for_sheet() from public, anon, authenticated;
grant execute on function public.schools_for_sheet() to service_role;

create or replace function public.teachers_for_sheet()
returns table (
  teacher_name text,
  email text,
  phone text,
  regions text,
  schools text,
  classes_this_year integer,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.full_name,
    u.email::text,
    p.phone,
    -- Derived from where they are scheduled, not profiles.region, which is
    -- null by design for teachers (0021).
    (select string_agg(distinct s.region::text, ', ' order by s.region::text)
       from public.calendar_events ce join public.schools s on s.id = ce.school_id
      where ce.teacher_ids @> array[p.id]),
    (select string_agg(distinct s.name, ', ' order by s.name)
       from public.calendar_events ce join public.schools s on s.id = ce.school_id
      where ce.teacher_ids @> array[p.id] and ce.start_at >= now() - interval '30 days'),
    (select count(*)::integer from public.calendar_events ce
      where ce.teacher_ids @> array[p.id] and ce.status = 'confirmed'
        and ce.start_at >= now() - interval '30 days'),
    case when p.archived_at is null then 'Active' else 'Archived' end
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.role = 'teacher'
  order by p.full_name;
$$;

revoke execute on function public.teachers_for_sheet() from public, anon, authenticated;
grant execute on function public.teachers_for_sheet() to service_role;

create or replace function public.programs_for_sheet()
returns table (program text, category text, objective text, active text)
language sql
stable
security definer
set search_path = ''
as $$
  select pr.name, pr.category, t.topic_name,
         case when pr.active and t.active then 'Yes' else 'No' end
  from public.programs pr
  join public.program_topics t on t.program_id = pr.id
  where pr.active
  order by pr.sort_order, t.sort_order;
$$;

revoke execute on function public.programs_for_sheet() from public, anon, authenticated;
grant execute on function public.programs_for_sheet() to service_role;

-- ===========================================================================
-- 5. Ticket insights
--
-- root_cause_report() already produces this; it is wrapped only to add the
-- human labels and to be service_role-callable without depending on
-- auth.uid(), which is null in a cron.
-- ===========================================================================

create or replace function public.ticket_insights_for_sheet()
returns table (
  root_cause text,
  category text,
  tickets integer,
  avg_resolution_hours numeric,
  schools_affected integer,
  teachers_affected integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case r.root_cause_category
      when 'Curriculum_Pedagogy'      then 'Curriculum & pedagogy'
      when 'Technology_Software'      then 'Technology & software'
      when 'Facilities_Logistics'     then 'Facilities & logistics'
      when 'Classroom_Mgmt_Safety'    then 'Classroom management & safety'
      when 'Payroll_Administrative'   then 'Payroll & administrative'
      else r.root_cause_category
    end,
    r.category_type,
    r.tickets,
    -- Hours, not minutes: nobody reasons about resolution time in minutes.
    round(r.avg_effective_ttr_minutes / 60.0, 1),
    r.schools_affected,
    r.teachers_affected
  from public.root_cause_report() r;
$$;

revoke execute on function public.ticket_insights_for_sheet() from public, anon, authenticated;
grant execute on function public.ticket_insights_for_sheet() to service_role;
