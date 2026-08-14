-- The sheet exporter follows 0046's cancellation path.
--
-- Three changes, and only the first adds a column:
--   1. cancellation_notes, appended LAST. COLUMN ORDER IS LOAD-BEARING — rows
--      are appended to a spreadsheet that already holds data, so a new field
--      goes at the end and an existing position is never reused. Blank on
--      every row written before the cancellation option existed.
--   2. quarter_goals_on_track is nullable now. `case when x then 'Yes' else
--      'No — falling behind' end` reports null as "falling behind", which
--      would put a claim in the spreadsheet the teacher never made about a
--      class that never happened.
--   3. The engagement label list gains the 4th level, so the sheet shows the
--      readable string rather than falling through to the raw enum.

drop function if exists public.feedback_for_sheet(integer);

create function public.feedback_for_sheet(p_limit integer default 500)
returns table (
  id uuid,
  submitted_at timestamptz,
  class_date date,
  class_time text,
  teacher_name text,
  teacher_email text,
  teacher_phone text,
  school_name text,
  region text,
  regional_manager text,
  class_title text,
  program text,
  engagement text,
  focus_pillar text,
  objectives text,
  open_notes text,
  quarter_goals_on_track text,
  reported_issue text,
  issue_category text,
  issue_type text,
  issue_priority text,
  issue_description text,
  ticket_number integer,
  ticket_status text,
  ticket_owner text,
  root_cause text,
  clock_in_status text,
  clock_in_at timestamptz,
  session_origin text,
  custom_program text,
  custom_notes text,
  cancellation_notes text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.id, f.submitted_at,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    p.full_name, u.email::text, p.phone, s.name, s.region::text,
    coalesce(
      owner.full_name,
      (select rm.full_name from public.profiles rm
        where rm.role = 'regional_manager' and rm.region = s.region and rm.archived_at is null
        order by rm.created_at limit 1)
    ),
    ce.summary,
    coalesce(pr.name, f.program_name_raw),
    case f.engagement_level
      when 'High' then 'High engagement & strong output'
      when 'Solid' then 'Solid / on target'
      when 'Low' then 'Low engagement / struggling'
      when 'Canceled' then 'Class canceled — no session held'
      else f.engagement_level
    end,
    -- Retired with the pillar-era form. Held in place so the columns to its
    -- right keep meaning what they meant in every row already written.
    null::text,
    -- Already labels since the objective selector; no lookup left to do.
    nullif(array_to_string(f.objectives_worked, ', '), ''),
    f.open_topic_note,
    -- Blank, not "No", when the class did not happen.
    case
      when f.quarter_goals_on_track is null then null
      when f.quarter_goals_on_track then 'Yes'
      else 'No — falling behind'
    end,
    case when f.has_issue then 'Yes' else 'No' end,
    tk.category_type,
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
    tk.priority_level, tk.description, tk.ticket_number, tk.status,
    owner.full_name, tk.root_cause_category,
    a.clock_in_status, a.clock_in_at, a.origin,
    f.custom_program_name, f.custom_notes,
    -- New, and therefore last.
    f.cancellation_notes
  from public.feedback_submissions f
  left join public.profiles p on p.id = f.teacher_id
  left join auth.users u on u.id = f.teacher_id
  left join public.schools s on s.id = f.school_id
  left join public.calendar_events ce on ce.id = f.event_id
  left join public.programs pr on pr.id = f.program_id
  left join public.attendance_sessions a on a.id = f.session_id
  left join public.tickets tk on tk.feedback_id = f.id
  left join public.profiles owner on owner.id = tk.assigned_agent_id
  where f.sheet_synced_at is null
  order by f.submitted_at
  limit p_limit;
$$;

-- Service-role only, unchanged: the sheet mirror is the only caller, and the
-- rows carry every teacher's phone and email across every region.
revoke execute on function public.feedback_for_sheet(integer) from public, anon, authenticated;
grant execute on function public.feedback_for_sheet(integer) to service_role;
