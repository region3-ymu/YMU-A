-- The feedback form's objective selector (YMU_Feedback_Form_Program_Objectives_Spec, Aug 12).
--
-- Section 2 stops being "pick a pillar, then pick chips inside it" and becomes
-- one flat, required multi-select over the program's own objective list. Three
-- decisions here override the written spec, all confirmed with YMU on
-- 2026-08-12 and worth restating because each one looks like a bug otherwise:
--
-- 1. THE TEACHER DOES NOT PICK THE PROGRAM. The spec has a dropdown; YMU cut
--    it. The program is derived from the calendar title and shown read-only,
--    which is why the "Other" path below has to exist at all — with no picker,
--    a teacher whose class was mis-detected has no other way out.
-- 2. MUSIC PRODUCTION RUNS. The spec omitted it by mistake. Its 30 objectives
--    are loaded and sit under a single pillar named `Objectives`.
-- 3. BEGINNER STRINGS, ORCHESTRA AND CONCERT BAND ARE ONE PROGRAM, not three.
--
-- pillar_category stops being read anywhere after this. The column stays on
-- program_topics — it is how the rows were loaded and it costs nothing — but
-- nothing groups by it, which is why Music Production's single `Objectives`
-- pillar and the others' four PRD pillars can coexist without the form caring.

-- ===========================================================================
-- 1. Schema
-- ===========================================================================

-- Labels, not uuids. A spreadsheet full of uuids is unreadable, the exporter
-- was already resolving them back to names on every read, and a snapshot of
-- what the teacher actually saw survives an objective being renamed or
-- retired later — which the id would not.
alter table public.feedback_submissions
  add column objectives_worked text[] not null default '{}',
  add column is_custom_program boolean not null default false,
  add column custom_program_name text,
  add column custom_notes text;

alter table public.feedback_submissions
  drop column primary_focus_pillar,
  drop column specific_topic_ids;

comment on column public.feedback_submissions.objectives_worked is
  'Objective LABELS, snapshotted at submit. Empty exactly when is_custom_program — see the feedback_objectives_xor_custom constraint.';
comment on column public.feedback_submissions.open_topic_note is
  'Historic. Written by the pillar-era form only; the objective selector that replaced it has no free-text field outside the custom-program path.';

-- Spec section 5, as a constraint rather than a convention: the two halves of
-- Section 2 are mutually exclusive, and a row carrying both would mean the
-- form let a teacher describe a program they had also just ticked objectives
-- for. Every existing row is is_custom_program = false with null custom
-- columns, so this validates as written.
alter table public.feedback_submissions
  add constraint feedback_objectives_xor_custom check (
    case when is_custom_program then
      cardinality(objectives_worked) = 0
      and custom_program_name is not null
      and custom_notes is not null
    else
      custom_program_name is null and custom_notes is null
    end
  );

-- ===========================================================================
-- 2. submit_class_feedback
--
-- DROP first, not CREATE OR REPLACE: the parameter list changes, and Postgres
-- would keep the old function as an overload rather than replacing it. The
-- deployed client would then keep resolving to the old one and keep writing to
-- columns that no longer exist.
-- ===========================================================================

drop function if exists public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text, uuid[], text, boolean, text, text, text, text
);

create or replace function public.submit_class_feedback(
  p_session_id uuid,
  p_engagement_level text,
  p_quarter_goals_on_track boolean,
  p_program_id uuid default null,
  p_program_name_raw text default null,
  p_objectives_worked text[] default '{}',
  p_is_custom_program boolean default false,
  p_custom_program_name text default null,
  p_custom_notes text default null,
  p_has_issue boolean default false,
  p_issue_category text default null,
  p_issue_subcategory text default null,
  p_issue_description text default null,
  p_priority_level text default 'Normal'
)
returns public.feedback_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions;
  v_row public.feedback_submissions;
  v_ticket_id uuid;
  v_owner uuid;
  v_region public.region;
  v_category text;
  v_custom boolean := coalesce(p_is_custom_program, false);
  v_custom_name text := nullif(btrim(coalesce(p_custom_program_name, '')), '');
  v_custom_notes text := nullif(btrim(coalesce(p_custom_notes, '')), '');
  v_objectives text[];
  v_program_id uuid;
  v_program_name text;
  v_offered integer;
  v_unknown text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit feedback.';
  end if;

  select * into v_session from public.attendance_sessions where id = p_session_id;
  if not found or v_session.teacher_id <> v_uid then
    raise exception 'That class could not be found.';
  end if;
  if v_session.feedback_settled_at is not null then
    raise exception 'You have already submitted feedback for this class.';
  end if;

  if p_engagement_level is null or p_engagement_level not in ('High', 'Solid', 'Low') then
    raise exception 'Please choose how students engaged today.';
  end if;
  if p_quarter_goals_on_track is null then
    raise exception 'Please answer whether you are on track with quarter goals.';
  end if;

  -- Trim, drop blanks, de-duplicate. A double-tap on the same checkbox must
  -- not make one objective count twice in the curriculum aggregates this
  -- whole section exists to feed.
  select coalesce(array_agg(distinct o), '{}')
    into v_objectives
    from unnest(coalesce(p_objectives_worked, '{}')) as o
   where nullif(btrim(o), '') is not null;

  if v_custom then
    -- The escape hatch. Both fields are required: a program name with no
    -- description tells a curriculum lead nothing they could act on.
    if v_custom_name is null then
      raise exception 'Please name the program you actually taught.';
    end if;
    if v_custom_notes is null then
      raise exception 'Please describe what you worked on.';
    end if;
    -- Spec section 5. The client already clears these when the teacher opens
    -- the escape hatch; this is what makes that guarantee rather than a habit.
    v_objectives := '{}';
    -- The detected program was wrong — that is the entire reason this path was
    -- taken — so it is not recorded as if it had been right. program_name_raw
    -- carries what the teacher says they taught; the calendar's own guess is
    -- still recoverable from the class title, which the sheet also carries.
    v_program_id := null;
    v_program_name := v_custom_name;
  else
    v_program_id := p_program_id;
    v_program_name := nullif(btrim(coalesce(p_program_name_raw, '')), '');

    -- Only objectives that really belong to this program. The checkboxes are
    -- rendered from that program's list, but a hand-crafted POST could send
    -- any string, and a foreign or invented objective would silently corrupt
    -- the aggregates without ever looking wrong in the spreadsheet.
    if v_program_id is not null and cardinality(v_objectives) > 0 then
      select o into v_unknown
        from unnest(v_objectives) as o
       where not exists (
         select 1 from public.program_topics t
          where t.program_id = v_program_id and t.active and t.topic_name = o
       )
       limit 1;
      if v_unknown is not null then
        raise exception 'That objective is not part of this program: %', v_unknown;
      end if;
    end if;

    -- Required, but only when there is something to require. A program whose
    -- objectives have not been loaded yet must not lock its teachers out of
    -- submitting at all; they get the custom path instead.
    select count(*) into v_offered
      from public.program_topics t
     where t.program_id = v_program_id and t.active;
    if coalesce(v_offered, 0) > 0 and cardinality(v_objectives) = 0 then
      raise exception 'Please choose at least one objective you worked on today.';
    end if;
  end if;

  if p_has_issue then
    if p_issue_category is null or btrim(p_issue_category) = '' then
      raise exception 'Please choose what kind of support you need.';
    end if;
    if p_issue_description is null or length(btrim(p_issue_description)) < 15 then
      raise exception 'Please describe the issue in at least 15 characters.';
    end if;
  end if;

  insert into public.feedback_submissions (
    session_id, teacher_id, school_id, event_id, program_id, program_name_raw,
    engagement_level, objectives_worked,
    is_custom_program, custom_program_name, custom_notes,
    quarter_goals_on_track, has_issue
  ) values (
    p_session_id, v_uid, v_session.school_id, v_session.event_id,
    v_program_id, v_program_name,
    p_engagement_level, v_objectives,
    v_custom,
    case when v_custom then v_custom_name end,
    case when v_custom then v_custom_notes end,
    p_quarter_goals_on_track, coalesce(p_has_issue, false)
  )
  returning * into v_row;

  update public.attendance_sessions
     set feedback_settled_at = now(),
         clock_out_at = coalesce(clock_out_at, least(now(), coalesce(scheduled_end_at, now()))),
         clock_out_source = coalesce(clock_out_source, 'feedback')
   where id = p_session_id;

  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: feedback submitted in-app')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  if p_has_issue or p_quarter_goals_on_track = false then
    select region into v_region from public.schools where id = v_session.school_id;
    v_owner := public.ticket_owner_for_school(v_session.school_id);

    v_category := case
      when p_has_issue then coalesce(nullif(btrim(coalesce(p_issue_category, '')), ''), 'Operational')
      else 'Academic'
    end;
    if v_category not in ('Operational', 'Academic') then
      v_category := 'Operational';
    end if;

    insert into public.tickets (
      teacher_id, school_id, event_id, session_id, feedback_id, region,
      category_type, issue_subcategory, priority_level, description, assigned_agent_id
    ) values (
      v_uid, v_session.school_id, v_session.event_id, p_session_id, v_row.id, v_region,
      v_category,
      nullif(btrim(coalesce(p_issue_subcategory, '')), ''),
      case when p_priority_level in ('Urgent', 'High', 'Normal') then p_priority_level else 'Normal' end,
      case
        when p_has_issue then btrim(p_issue_description)
        else 'Reported falling behind on quarter/concert goals via the daily feedback form.'
      end,
      v_owner
    )
    returning id into v_ticket_id;

    if v_owner is null then
      insert into public.flags (type, session_id, event_id, teacher_id, school_id, details)
      values (
        'ticket_unassigned', p_session_id, v_session.event_id, v_uid, v_session.school_id,
        jsonb_build_object('ticket_id', v_ticket_id, 'region', v_region)
      );
    else
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_owner, v_session.event_id, 'ticket_opened',
        public.manager_notification_payload(v_uid, v_session.school_id, v_session.event_id)
          || jsonb_build_object('ticket_id', v_ticket_id, 'category_type', v_category)
      );
    end if;
  end if;

  return v_row;
end;
$$;

revoke execute on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text[], boolean, text, text, boolean, text, text, text, text
) from public, anon;
grant execute on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text[], boolean, text, text, boolean, text, text, text, text
) to authenticated;

-- ===========================================================================
-- 3. The sheet exporter follows the schema
--
-- COLUMN ORDER IS LOAD-BEARING. Rows are appended to a spreadsheet that
-- already holds data, so a new field goes at the END and an existing position
-- is never reused for a different meaning. `focus_pillar` therefore stays
-- exactly where it is and starts returning null forever: the historic rows in
-- the sheet still mean what they said, and nothing below them shifts.
-- ===========================================================================

drop function if exists public.feedback_for_sheet(integer);

create or replace function public.feedback_for_sheet(p_limit integer default 500)
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
  custom_notes text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.id,
    f.submitted_at,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    p.full_name,
    u.email::text,
    p.phone,
    s.name,
    s.region::text,
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
      else f.engagement_level
    end,
    -- Retired with the pillar-era form. Held in place so the columns to its
    -- right keep meaning what they meant in every row already written.
    null::text,
    -- Already labels since the objective selector; no lookup left to do.
    nullif(array_to_string(f.objectives_worked, ', '), ''),
    f.open_topic_note,
    case when f.quarter_goals_on_track then 'Yes' else 'No — falling behind' end,
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
    tk.priority_level,
    tk.description,
    tk.ticket_number,
    tk.status,
    owner.full_name,
    tk.root_cause_category,
    a.clock_in_status,
    a.clock_in_at,
    a.origin,
    -- New, and therefore last.
    f.custom_program_name,
    f.custom_notes
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
