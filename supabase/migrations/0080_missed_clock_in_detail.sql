-- ===========================================================================
-- 0080 — when a flag stays missed, ask the questions that follow
-- ===========================================================================
--
-- 0076 gave a resolved flag a reason code. That answers "why was the clock-in
-- late", which is the right question for the 39% of cases where the teacher
-- was there and forgot. It is the wrong question when the teacher genuinely
-- was not there, and that is the case with consequences: payroll, the school's
-- relationship, and whether this is a pattern.
--
-- YMU asked for three things on that path (2026-08-21): did they give notice
-- and how, is it excused, and why were they away. Plus a link to who covered
-- it, so "who actually taught this class" stops being a sentence somebody
-- typed:
--
--   "No change in payroll adjustment. Confirmed DeAnthony as the substitute
--    for this class."
--
-- ── Where these live ─────────────────────────────────────────────────────
--
-- In flags.details, beside resolution_reason and resolution_notes. Not as
-- columns: five of the six only apply to the one flag type out of four, and
-- four nullable columns that are always null for a feedback_stuck flag is a
-- worse description of the world than a jsonb key that is simply absent.
-- resolution_notes has lived there since 0012 for the same reason.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The two small lists
-- ---------------------------------------------------------------------------
-- absence_reason_label() is 0079's and is reused as-is — "why was the teacher
-- away" is one question whether it is asked on the substitutions screen or on
-- a flag card.

create or replace function public.flag_outcome_label(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'attendance_corrected' then 'They were here — attendance corrected'
    when 'stayed_missed'        then 'They were absent'
    when 'substitute_covered'   then 'A substitute covered the class'
    when 'class_not_held'       then 'The class did not happen'
  end;
$$;

comment on function public.flag_outcome_label(text) is
  'What a manager decided actually happened. Twin of src/lib/attendance/flag-outcomes.ts.';

grant execute on function public.flag_outcome_label(text) to authenticated, service_role;

create or replace function public.notice_channel_label(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'called'         then 'Called'
    when 'texted'         then 'Texted / WhatsApp'
    when 'emailed'        then 'Emailed'
    when 'told_colleague' then 'Told a colleague or the school'
    when 'none'           then 'No notice at all'
  end;
$$;

comment on function public.notice_channel_label(text) is
  'How a teacher let YMU know they would be away. ''none'' is a real answer and the one worth counting.';

grant execute on function public.notice_channel_label(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. resolve_flag, with the outcome and what follows from it
-- ---------------------------------------------------------------------------
-- The validation is the interesting part. Each outcome demands exactly the
-- fields that outcome means, and refuses the ones it does not:
--
--   stayed_missed      -> notice channel and excused, both required.
--                         "They were absent" with nothing else recorded is the
--                         gap this migration exists to close.
--   substitute_covered -> a substitution row, and it must be for THIS class
--                         and THIS teacher. A free-text name was the old way
--                         and it joined to nothing.
--   attendance_corrected / class_not_held
--                      -> neither. A teacher who was in fact present has no
--                         absence to excuse, and offering the field invites a
--                         manager to fill it in anyway.
--
-- Dropped and recreated rather than defaulted, for the reason 0076 gives: two
-- overloads differing only by defaulted arguments resolve as ambiguous.

drop function if exists public.resolve_flag(uuid, text, text);

create or replace function public.resolve_flag(
  p_flag_id             uuid,
  p_reason              text,
  p_notes               text default null,
  p_outcome             text default null,
  p_absence_reason      text default null,
  p_notified_in_advance boolean default null,
  p_notified_channel    text default null,
  p_excused             boolean default null,
  p_substitution_id     uuid default null
)
returns public.flags
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_role   public.app_role := public.current_app_role();
  v_flag   public.flags%rowtype;
  v_note   text;
  v_detail jsonb := '{}'::jsonb;
  v_sub    public.substitutions;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if not (v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions()) then
    raise exception 'Only managers can resolve flags.';
  end if;

  v_note := public.flag_resolution_note('', p_reason, p_notes);

  select * into v_flag from public.flags where id = p_flag_id;
  if not found then
    raise exception 'Flag not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned_event(v_flag.event_id) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    if v_flag.school_id is not null and not exists (
      select 1 from public.schools s
      where s.id = v_flag.school_id and (s.region is null or s.region = public.current_app_region())
    ) then
      raise exception 'You can only resolve flags in your own region.';
    end if;
  elsif v_role = 'afterschool_manager' and not public.afterschool_owned_event(v_flag.event_id) then
    raise exception 'You can only resolve flags on afterschool classes.';
  end if;

  -- The outcome is optional so the other three flag types, and the everyday
  -- "they forgot" case, stay a two-field form. Everything below only applies
  -- once a manager has said what happened.
  if p_outcome is not null then
    if public.flag_outcome_label(p_outcome) is null then
      raise exception 'Choose what happened. "%" is not one of the options.', p_outcome;
    end if;
    v_detail := v_detail || jsonb_build_object('resolution_outcome', p_outcome);

    if p_outcome in ('stayed_missed', 'substitute_covered') then
      if public.absence_reason_label(p_absence_reason) is null then
        raise exception 'Choose why the teacher was away.';
      end if;
      if p_absence_reason = 'other' and nullif(btrim(coalesce(p_notes, '')), '') is null then
        raise exception 'Choosing "Other" for the absence means writing what happened.';
      end if;
      v_detail := v_detail || jsonb_build_object('absence_reason', p_absence_reason);
    elsif p_absence_reason is not null then
      raise exception 'An absence reason does not apply when the teacher was here.';
    end if;

    if p_outcome = 'stayed_missed' then
      if p_notified_in_advance is null then
        raise exception 'Record whether the teacher let anyone know in advance.';
      end if;
      if public.notice_channel_label(p_notified_channel) is null then
        raise exception 'Record how the teacher let anyone know — "No notice at all" is an answer.';
      end if;
      -- The one pair that can contradict itself. "They gave notice" and "no
      -- notice at all" cannot both be true, and a row saying both is worse
      -- than a row saying neither.
      if p_notified_in_advance and p_notified_channel = 'none' then
        raise exception 'They either gave notice or they did not — pick a channel, or say they gave none.';
      end if;
      if not p_notified_in_advance and p_notified_channel <> 'none' then
        raise exception 'A channel means they did give notice.';
      end if;
      if p_excused is null then
        raise exception 'Record whether this absence is excused.';
      end if;
      v_detail := v_detail || jsonb_build_object(
        'notified_in_advance', p_notified_in_advance,
        'notified_channel',    p_notified_channel,
        'excused',             p_excused
      );
    elsif p_notified_in_advance is not null or p_notified_channel is not null or p_excused is not null then
      raise exception 'Notice and excusal only apply when the teacher was absent.';
    end if;

    if p_outcome = 'substitute_covered' then
      if p_substitution_id is null then
        raise exception 'Pick the substitution that covered this class, or record one first.';
      end if;
      select * into v_sub from public.substitutions where id = p_substitution_id;
      if not found then
        raise exception 'Substitution not found.';
      end if;
      -- The whole point of a link over a typed name: it can be wrong, and
      -- being wrong can be detected.
      if v_sub.event_id is distinct from v_flag.event_id then
        raise exception 'That substitution is for a different class.';
      end if;
      if v_sub.absent_teacher_id is distinct from v_flag.teacher_id then
        raise exception 'That substitution covers a different teacher.';
      end if;
      if v_sub.status <> 'confirmed' then
        raise exception 'That substitution was cancelled.';
      end if;
      v_detail := v_detail || jsonb_build_object('substitution_id', p_substitution_id);
    elsif p_substitution_id is not null then
      raise exception 'A substitution only applies when a substitute covered the class.';
    end if;
  end if;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb)
           || jsonb_build_object(
                'resolution_reason', p_reason,
                'resolution_notes',  v_note
              )
           || v_detail
   where id = p_flag_id
   returning * into v_flag;

  return v_flag;
end;
$$;

comment on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) is
  'Closes a flag with a reason code and, when the manager says what actually happened, the structured detail that outcome implies: why the teacher was away, whether they gave notice and how, whether it is excused, and which substitution covered the class. Each outcome requires exactly its own fields and refuses the others.';

revoke execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) from public, anon;
grant execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The Flags tab carries it
-- ---------------------------------------------------------------------------
-- Body is 0078's, with six columns added at the end. "Covered by" is the one
-- that closes the loop: a manager filtering Attendance for missed classes can
-- now see, on the same row, the name of whoever actually taught it.

create or replace function public.flags_for_sheet()
returns table (
  flag_id uuid,
  raised_date date,
  raised_time text,
  flag_type text,
  teacher_name text,
  school_name text,
  region text,
  class_title text,
  class_date date,
  class_time text,
  status text,
  minutes_late integer,
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text,
  outcome text,
  absence_reason text,
  notified_in_advance text,
  notified_how text,
  excused text,
  covered_by text,
  resolution_notes text,
  distance_m integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.id,
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
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    case when f.resolved_at is null then 'Open' else 'Resolved' end,
    coalesce(
      (f.details->>'minutes_late')::integer,
      case
        when asn.clock_in_at is not null and ce.start_at is not null
         and asn.clock_in_at > ce.start_at
        then (extract(epoch from (asn.clock_in_at - ce.start_at)) / 60)::integer
      end
    ),
    f.resolved_at,
    coalesce(
      resolver.full_name,
      case f.details->>'auto_resolved_by'
        when 'clock_in'        then 'Automatic — teacher clocked in within 15 min'
        when 'clock_in_exempt' then 'Automatic — teacher is clock-in exempt'
        when 'back_to_back'    then 'Automatic — back-to-back class carried over'
        else 'Automatic — ' || (f.details->>'auto_resolved_by')
      end
    ),
    public.flag_reason_label(f.details->>'resolution_reason'),
    public.flag_outcome_label(f.details->>'resolution_outcome'),
    public.absence_reason_label(f.details->>'absence_reason'),
    case f.details->>'notified_in_advance'
      when 'true'  then 'Yes'
      when 'false' then 'No'
    end,
    public.notice_channel_label(f.details->>'notified_channel'),
    case f.details->>'excused'
      when 'true'  then 'Yes'
      when 'false' then 'No'
    end,
    stand_in.full_name,
    f.details->>'resolution_notes',
    coalesce(
      (f.details->>'distance_m')::integer,
      asn.clock_in_distance_m::integer
    )
  from public.flags f
  left join public.profiles p on p.id = f.teacher_id
  left join public.schools s on s.id = f.school_id
  left join public.calendar_events ce on ce.id = f.event_id
  left join public.profiles resolver on resolver.id = f.resolved_by
  left join public.attendance_sessions asn
    on asn.event_id = f.event_id and asn.teacher_id = f.teacher_id
  -- Through the linked substitution, not by matching names. The link is why
  -- this column can be trusted.
  left join public.substitutions sub
    on sub.id = nullif(f.details->>'substitution_id', '')::uuid
  left join public.profiles stand_in on stand_in.id = sub.substitute_teacher_id
  order by f.created_at desc;
$$;

comment on function public.flags_for_sheet() is
  'Every flag, open and resolved, with its reason code, what the manager decided happened, the absence detail that follows from it, and who covered the class.';

revoke execute on function public.flags_for_sheet() from public, anon, authenticated;
grant execute on function public.flags_for_sheet() to service_role;
