-- ===========================================================================
-- 0096 — two loose ends from the "teacher was absent" fix (0095)
-- ===========================================================================
--
-- region3@ymu.org, 2026-09-03:
--
--   1. The "forgot" reason's label says "— was there on time", but the
--      manager already answers on-time-vs-late separately (the Status select
--      on "Record attendance", right below the reason). Redundant, and reads
--      as though the reason picker is deciding it. Shortened to "Forgot to
--      clock in".
--
--   2. 0095 fixed resolve_flag()'s stayed_missed and substitute_covered
--      outcomes to actually write an attendance_sessions row. class_not_held
--      is the same shape of bug and was missed: picking "The class did not
--      happen" on "Mark resolved" still only touches flags.details today,
--      same as attendance_corrected still does (a separate, not-yet-fixed
--      gap — see the spawned follow-up task). Fixed here since it needs no
--      new form fields (like stayed_missed/substitute_covered, "the class
--      did not happen" needs no clock-in time or status question — the
--      answer is always not_held).
--
--      This is also what makes "which button do I use" answerable: for a
--      late_clock_in flag, "Mark resolved" + an outcome now fully covers
--      teacher-absent, substitute-covered, and class-not-held end to end.
--      "Record attendance" remains for the one outcome that still isn't
--      wired this way (attendance_corrected) and for correcting/creating a
--      record with no flag involved at all.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The label
-- ---------------------------------------------------------------------------

create or replace function public.flag_reason_label(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'forgot'              then 'Forgot to clock in'
    when 'tech_problem'        then 'App or phone problem'
    when 'calendar_time_wrong' then 'Calendar time is wrong — class starts later'
    when 'no_internet'         then 'No internet at the school'
    when 'teacher_absent'      then 'Teacher was absent'
    when 'class_not_held'      then 'Class did not happen'
    when 'other'               then 'Other'
  end;
$$;

comment on function public.flag_reason_label(text) is
  'The label for a late-clock-in reason code, or null if the code is not one of the seven. Twin of src/lib/attendance/flag-reasons.ts.';

-- ---------------------------------------------------------------------------
-- 2. resolve_flag() — class_not_held now writes the same not_held record
--    admin_create_attendance already would
-- ---------------------------------------------------------------------------
-- Same signature as 0095's — a body-only change, no drop needed.

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
  v_event  public.calendar_events;
  v_existing_session_id uuid;
  v_new_status text;
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

    -- stayed_missed/substitute_covered -> absent (unpaid, 0095).
    -- class_not_held -> not_held (paid, not taught) — same status
    -- admin_create_attendance already gives that reason, now reachable from
    -- here too so "Mark resolved" alone is enough for it.
    -- attendance_corrected is deliberately NOT handled here yet: unlike the
    -- other three, it needs a clock-in time and on-time/late answer this
    -- form does not collect. Use "Record attendance" for that one outcome
    -- until it gets its own fields.
    v_new_status := case
      when p_outcome in ('stayed_missed', 'substitute_covered') then 'absent'
      when p_outcome = 'class_not_held' then 'not_held'
      else null
    end;

    if v_new_status is not null then
      if v_flag.event_id is null or v_flag.teacher_id is null then
        raise exception 'This flag is not linked to a class and teacher, so an outcome does not apply.';
      end if;

      select * into v_event from public.calendar_events where id = v_flag.event_id;
      if not found then
        raise exception 'Class not found.';
      end if;

      select id into v_existing_session_id
        from public.attendance_sessions
       where event_id = v_flag.event_id and teacher_id = v_flag.teacher_id;

      if v_existing_session_id is not null then
        update public.attendance_sessions
           set clock_in_status          = v_new_status,
               absence_reason           = p_absence_reason,
               absence_excused          = p_excused,
               absence_notified_channel = p_notified_channel,
               admin_edited_at          = now(),
               admin_edited_by          = v_uid,
               admin_edit_reason        = v_note,
               feedback_due_at          = null,
               feedback_settled_at      = coalesce(feedback_settled_at, now())
         where id = v_existing_session_id;
      else
        insert into public.attendance_sessions (
          teacher_id, event_id, school_id, clock_in_at, clock_in_status,
          absence_reason, absence_excused, absence_notified_channel,
          scheduled_start_at, scheduled_end_at, feedback_due_at, feedback_settled_at,
          clock_out_at, clock_out_source,
          origin, admin_edited_at, admin_edited_by, admin_edit_reason
        ) values (
          v_flag.teacher_id, v_flag.event_id, v_event.school_id, v_event.start_at, v_new_status,
          p_absence_reason, p_excused, p_notified_channel,
          v_event.start_at, v_event.end_at, null, now(),
          case when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at end,
          case when v_event.end_at is not null and v_event.end_at <= now() then 'admin' end,
          'admin', now(), v_uid, v_note
        );
      end if;
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
  'Closes a flag with a reason code and, when the manager says what actually happened, the structured detail that outcome implies. stayed_missed/substitute_covered create an unpaid absent session; class_not_held creates a paid not_held session (0096). attendance_corrected still only annotates flags.details — it needs a clock-in time/status this form does not collect yet.';

revoke execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) from public, anon;
grant execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid) to authenticated;
