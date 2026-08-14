-- Module A: "Class Canceled — No Session Held".
-- Spec: YMU_Feedback_Form_Class_Cancellation_Spec.md, Juan Pelaez, 2026-08-13.
--
-- Every feedback submission until now assumed the class actually happened —
-- engagement, objectives and quarter-goal progress all presuppose a session.
-- When a class is cancelled the teacher still owes a log inside the 24-hour
-- window or they cannot clock in again, so they were filling in answers about
-- a class that never took place. That is worse than missing data: it is wrong
-- data, in the aggregates that drive PD planning.
--
-- The fix is a 4th option on the existing Section 1 question rather than a new
-- question or screen, so the normal path gains no extra steps.
--
-- Choosing it:
--   * skips Sections 2 and 3 entirely (they do not apply);
--   * offers one optional Cancellation Notes field;
--   * files an Operational / "Class cancelled on site" ticket automatically,
--     routed by the same School -> region -> RM lookup as any other ticket;
--   * still settles the session, so it clears the 24-hour clock-in gate.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.feedback_submissions
  drop constraint feedback_submissions_engagement_level_check;

alter table public.feedback_submissions
  add constraint feedback_submissions_engagement_level_check
  check (engagement_level in ('High', 'Solid', 'Low', 'Canceled'));

-- A class that did not happen has no quarter-goal progress to report. Null is
-- the honest answer; false would read as "falling behind" and open a ticket.
alter table public.feedback_submissions
  alter column quarter_goals_on_track drop not null;

alter table public.feedback_submissions
  add column if not exists cancellation_notes text;

comment on column public.feedback_submissions.cancellation_notes is
  'Optional free text from the teacher when engagement_level = ''Canceled''. Becomes the auto-created ticket''s description. Null for every other engagement level, enforced by feedback_cancelled_shape.';

-- Acceptance criterion 5, enforced rather than trusted. The client clears the
-- notes when a teacher switches back to a real engagement level; this is what
-- makes stale cancellation data impossible rather than merely unlikely — and
-- symmetrically, a cancelled log can never carry objectives or a goal answer.
alter table public.feedback_submissions
  add constraint feedback_cancelled_shape check (
    case
      when engagement_level = 'Canceled' then
        cardinality(objectives_worked) = 0
        and is_custom_program = false
        and quarter_goals_on_track is null
      else
        quarter_goals_on_track is not null
        and cancellation_notes is null
    end
  );

-- ---------------------------------------------------------------------------
-- submit_class_feedback
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: the new p_cancellation_notes parameter would
-- otherwise create an overload, and PostgREST would have two candidates to
-- choose between.

drop function if exists public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text[], boolean, text, text, boolean, text, text, text, text
);

create function public.submit_class_feedback(
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
  p_priority_level text default 'Normal',
  p_cancellation_notes text default null
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
  v_cancelled boolean := p_engagement_level = 'Canceled';
  v_cancel_notes text := nullif(btrim(coalesce(p_cancellation_notes, '')), '');
  v_subcategory text;
  v_priority text;
  v_description text;
  v_opens_ticket boolean;
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

  if p_engagement_level is null
     or p_engagement_level not in ('High', 'Solid', 'Low', 'Canceled') then
    raise exception 'Please choose how students engaged today.';
  end if;

  if v_cancelled then
    -- Nothing else to validate. The whole point of this path is that a class
    -- that did not happen has no objectives, no program and no goal progress,
    -- and the notes are explicitly optional (spec section 3).
    v_objectives := '{}';
    v_custom := false;
    v_custom_name := null;
    v_custom_notes := null;
    v_program_id := null;
    v_program_name := null;
  else
    if p_quarter_goals_on_track is null then
      raise exception 'Please answer whether you are on track with quarter goals.';
    end if;

    -- Trim, drop blanks, de-duplicate. A double-tap on the same checkbox must
    -- not make one objective count twice in the curriculum aggregates this
    -- whole section exists to feed.
    --
    -- btrim is applied to the AGGREGATED value, not just to the filter.
    -- Trimming only in the where clause drops blanks but keeps padding on
    -- everything else, so "  Warm-ups  " survives as a distinct string and
    -- then fails the program-topic check below with a message naming an
    -- objective that visibly exists.
    select coalesce(array_agg(distinct btrim(o)), '{}')
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
      -- The detected program was wrong — that is the entire reason this path
      -- was taken — so it is not recorded as if it had been right.
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
  end if;

  insert into public.feedback_submissions (
    session_id, teacher_id, school_id, event_id, program_id, program_name_raw,
    engagement_level, objectives_worked,
    is_custom_program, custom_program_name, custom_notes,
    quarter_goals_on_track, has_issue, cancellation_notes
  ) values (
    p_session_id, v_uid, v_session.school_id, v_session.event_id,
    v_program_id, v_program_name,
    p_engagement_level, v_objectives,
    v_custom,
    case when v_custom then v_custom_name end,
    case when v_custom then v_custom_notes end,
    case when v_cancelled then null else p_quarter_goals_on_track end,
    -- has_issue stays false for a cancellation: the teacher did not report a
    -- problem with a class, and flipping it would fold cancellations into the
    -- "issues raised" counts. engagement_level = 'Canceled' is the marker.
    case when v_cancelled then false else coalesce(p_has_issue, false) end,
    case when v_cancelled then v_cancel_notes end
  )
  returning * into v_row;

  -- Unchanged, and the reason a cancelled log still clears the 24-hour gate
  -- (acceptance criterion 4): the gate reads feedback_settled_at.
  update public.attendance_sessions
     set feedback_settled_at = now(),
         clock_out_at = coalesce(clock_out_at, least(now(), coalesce(scheduled_end_at, now()))),
         clock_out_source = coalesce(clock_out_source, 'feedback')
   where id = p_session_id;

  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: feedback submitted in-app')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  v_opens_ticket := v_cancelled
    or coalesce(p_has_issue, false)
    or p_quarter_goals_on_track = false;

  if v_opens_ticket then
    select region into v_region from public.schools where id = v_session.school_id;
    v_owner := public.ticket_owner_for_school(v_session.school_id);

    if v_cancelled then
      v_category := 'Operational';
      -- 'cancelled' is "Class cancelled on site" in the Module B mapping
      -- (src/lib/feedback/program-match.ts) — reused, not invented here.
      v_subcategory := 'cancelled';
      v_priority := 'Normal';
      -- The prefix is load-bearing, not decoration: tickets_description_check
      -- requires 15 characters and a teacher may well type "sick".
      v_description := case
        when v_cancel_notes is null then 'Class canceled — no additional notes provided.'
        else 'Class canceled — ' || v_cancel_notes
      end;
    else
      v_category := case
        when p_has_issue then coalesce(nullif(btrim(coalesce(p_issue_category, '')), ''), 'Operational')
        else 'Academic'
      end;
      if v_category not in ('Operational', 'Academic') then
        v_category := 'Operational';
      end if;
      v_subcategory := nullif(btrim(coalesce(p_issue_subcategory, '')), '');
      v_priority := case
        when p_priority_level in ('Urgent', 'High', 'Normal') then p_priority_level
        else 'Normal'
      end;
      v_description := case
        when p_has_issue then btrim(p_issue_description)
        else 'Reported falling behind on quarter/concert goals via the daily feedback form.'
      end;
    end if;

    insert into public.tickets (
      teacher_id, school_id, event_id, session_id, feedback_id, region,
      category_type, issue_subcategory, priority_level, description, assigned_agent_id
    ) values (
      v_uid, v_session.school_id, v_session.event_id, p_session_id, v_row.id, v_region,
      v_category, v_subcategory, v_priority, v_description, v_owner
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

comment on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text[], boolean, text, text, boolean, text, text, text, text, text
) is
  'Writes one daily class feedback log, settles the session (clearing the 24-hour clock-in gate) and files a ticket when one is warranted. engagement_level = ''Canceled'' skips objectives and quarter goals entirely and always files an Operational / "Class cancelled on site" ticket routed by ticket_owner_for_school().';

revoke execute on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text[], boolean, text, text, boolean, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text[], boolean, text, text, boolean, text, text, text, text, text
) to authenticated;
