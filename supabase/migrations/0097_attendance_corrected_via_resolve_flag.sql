-- ===========================================================================
-- 0097 — the last outcome, and one button instead of two on /flags
-- ===========================================================================
--
-- region3@ymu.org, 2026-09-03: "sigo sin entender la diferencia... se pueden
-- combinar y dejar una sola?" — yes. The confusion was real: "Record
-- attendance" and "Mark resolved" shared the exact same seven-item Reason
-- list (ReasonPicker/FLAG_REASONS), and "Mark resolved" additionally listed
-- class_not_held and (as stayed_missed) teacher_absent a SECOND time in its
-- own Outcome dropdown — the same two ideas, asked twice, in two different
-- vocabularies, on the same card.
--
-- 0095/0096 already made three of the four outcomes (stayed_missed,
-- substitute_covered, class_not_held) write the real attendance_sessions
-- row. attendance_corrected ("They were here — attendance corrected") was
-- the one holdout, because it is the one outcome that needs information the
-- others don't: a clock-in time and an on-time/late answer. This migration
-- adds exactly those two fields to resolve_flag() (client side:
-- resolve-flag-button.tsx, gated behind outcomeNeedsClockIn()), so all four
-- outcomes now do the real work.
--
-- With that done, /flags/page.tsx stops rendering "Record attendance"
-- alongside a late_clock_in flag's "Mark resolved" — one button, one form,
-- one place to answer "what happened". "Record attendance" still exists on
-- the Dashboard's "Missing clock-ins today" widget, which is a genuinely
-- different moment (no flag has necessarily been reviewed yet) — that use is
-- untouched.
--
-- New parameters appended at the end with defaults, and the function
-- DROPPED first — same reasoning 0080 gave: create-or-replace with a
-- different parameter list creates a second overload instead of replacing
-- the first, so a stale 9-arg call would resolve ambiguously rather than
-- failing at deploy time.
-- ===========================================================================

drop function if exists public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid);

create or replace function public.resolve_flag(
  p_flag_id             uuid,
  p_reason              text,
  p_notes               text default null,
  p_outcome             text default null,
  p_absence_reason      text default null,
  p_notified_in_advance boolean default null,
  p_notified_channel    text default null,
  p_excused             boolean default null,
  p_substitution_id     uuid default null,
  p_clock_in_at         timestamptz default null,
  p_clock_in_status     text default null
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
  v_no_feedback boolean;
  v_due timestamptz;
  v_clock_in_at timestamptz;
  v_clock_out timestamptz;
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

    if p_outcome = 'attendance_corrected' then
      if p_clock_in_at is null then
        raise exception 'Record when they actually clocked in.';
      end if;
      if p_clock_in_status not in ('on_time', 'late') then
        raise exception 'Record whether they were on time or late.';
      end if;
    elsif p_clock_in_at is not null or p_clock_in_status is not null then
      raise exception 'A clock-in time only applies to "They were here".';
    end if;

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

    -- Every outcome now maps to a real attendance_sessions status:
    --   stayed_missed / substitute_covered -> absent    (unpaid,   0095)
    --   class_not_held                     -> not_held  (paid,     0096)
    --   attendance_corrected               -> the on_time/late the manager
    --                                          just entered (paid, owes
    --                                          feedback like any real
    --                                          clock-in) -- new here.
    v_new_status := case
      when p_outcome in ('stayed_missed', 'substitute_covered') then 'absent'
      when p_outcome = 'class_not_held' then 'not_held'
      when p_outcome = 'attendance_corrected' then p_clock_in_status
    end;
    -- absent/not_held owe no feedback (nobody taught the class); on_time/late
    -- owes feedback exactly like a real clock-in would.
    v_no_feedback := v_new_status in ('absent', 'not_held');
    v_clock_in_at := case when p_outcome = 'attendance_corrected' then p_clock_in_at end;

    if v_flag.event_id is null or v_flag.teacher_id is null then
      raise exception 'This flag is not linked to a class and teacher, so an outcome does not apply.';
    end if;

    select * into v_event from public.calendar_events where id = v_flag.event_id;
    if not found then
      raise exception 'Class not found.';
    end if;

    v_clock_out := case
      when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at
    end;
    -- 0085's floor: never born overdue.
    v_due := case
      when v_no_feedback then null
      when v_event.end_at is null then null
      else greatest(v_event.end_at + interval '24 hours', now() + interval '24 hours')
    end;

    select id into v_existing_session_id
      from public.attendance_sessions
     where event_id = v_flag.event_id and teacher_id = v_flag.teacher_id;

    if v_existing_session_id is not null then
      update public.attendance_sessions
         set clock_in_status          = v_new_status,
             -- Only attendance_corrected supplies a real clock-in time;
             -- absent/not_held leave whatever the row already had alone.
             clock_in_at              = coalesce(v_clock_in_at, clock_in_at),
             absence_reason           = p_absence_reason,
             absence_excused          = p_excused,
             absence_notified_channel = p_notified_channel,
             admin_edited_at          = now(),
             admin_edited_by          = v_uid,
             admin_edit_reason        = v_note,
             -- Only touch the feedback demand when the status itself waives
             -- or restores it — correcting on_time<->late on an existing
             -- session should not reset a due date that was already ticking.
             feedback_due_at          = case when v_no_feedback then null else feedback_due_at end,
             feedback_settled_at      = case
                                          when v_no_feedback then coalesce(feedback_settled_at, now())
                                          else feedback_settled_at
                                        end
       where id = v_existing_session_id;
    else
      insert into public.attendance_sessions (
        teacher_id, event_id, school_id, clock_in_at, clock_in_status,
        absence_reason, absence_excused, absence_notified_channel,
        scheduled_start_at, scheduled_end_at, feedback_due_at, feedback_settled_at,
        clock_out_at, clock_out_source,
        origin, admin_edited_at, admin_edited_by, admin_edit_reason
      ) values (
        v_flag.teacher_id, v_flag.event_id, v_event.school_id,
        coalesce(v_clock_in_at, v_event.start_at), v_new_status,
        p_absence_reason, p_excused, p_notified_channel,
        v_event.start_at, v_event.end_at, v_due,
        case when v_no_feedback then now() end,
        v_clock_out,
        case when v_clock_out is null then null else 'admin' end,
        'admin', now(), v_uid, v_note
      );
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

comment on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid, timestamptz, text) is
  'Closes a flag with a reason code and, when the manager says what actually happened, the structured detail that outcome implies AND the matching attendance_sessions write: stayed_missed/substitute_covered -> absent (unpaid), class_not_held -> not_held (paid, not taught), attendance_corrected -> on_time/late (paid, feedback owed) using the clock-in time/status supplied. All four outcomes now fully handle a late_clock_in flag on their own — "Record attendance" is no longer shown alongside one on /flags.';

revoke execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid, timestamptz, text) from public, anon;
grant execute on function public.resolve_flag(uuid, text, text, text, text, boolean, text, boolean, uuid, timestamptz, text) to authenticated;
