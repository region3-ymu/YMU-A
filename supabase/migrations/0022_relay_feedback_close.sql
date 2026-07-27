-- Temporary parallel feedback-close path for this week's professional
-- development sessions ("YMU Teacher Relays"), replacing the paused Zoho
-- form (see BUGS.md) for THIS version only — the official version still
-- needs the real Zoho form. Faithfully replicates the real reference form
-- ("YMU Teacher Relays – Teacher Self-Reflection Form",
-- https://forms.gle/pbPnA2URdq33rdiV9, read directly out of its
-- FB_PUBLIC_LOAD_DATA_ payload, not guessed) as a NATIVE in-app form
-- instead of an external Google Form: the teacher fills it out directly in
-- the app, submitting through an authenticated RPC (no external relay, no
-- webhook, no shared secret) — the same shape as this app's very first,
-- pre-Zoho-rework `clock_out_with_feedback` (0008), just with this form's
-- actual questions instead of that invented rating/summary schema.
--
-- The reference form also asks "Teacher Name" and "Day of Session" —
-- skipped here on purpose since the app already knows both (the
-- authenticated caller and the session's clock-in date), matching how the
-- Zoho integration already auto-fills school/teacher/date/class rather than
-- re-asking. Every other question is asked verbatim.
--
-- This does NOT touch any Zoho code or column — both paths coexist,
-- switchable via FEEDBACK_FORM_PROVIDER (see NEXT_STEPS.md).

alter table public.attendance_sessions
  add column relay_block text,
  add column relay_program_area text,
  add column relay_objective text,
  add column relay_achieved_objective text,
  add column relay_objective_reflection text,
  add column relay_engagement_scale smallint,
  add column relay_challenges text[],
  add column relay_pivots text,
  add column relay_feedback_submitted_at timestamptz,
  add constraint attendance_relay_block_check
    check (relay_block is null or relay_block in ('Block 1', 'Block 2', 'Block 3', 'Block 4')),
  add constraint attendance_relay_program_area_check
    check (relay_program_area is null or relay_program_area in
      ('Modern Band', 'Drumline', 'Beginning Band / Winds', 'Music Production')),
  add constraint attendance_relay_achieved_objective_check
    check (relay_achieved_objective is null or relay_achieved_objective in
      ('Yes - Fully achieved', 'Partially - Achieved with minor adjustments', 'No - Did not achieve')),
  add constraint attendance_relay_engagement_scale_check
    check (relay_engagement_scale is null or relay_engagement_scale between 1 and 5);

comment on column public.attendance_sessions.relay_block is
  'PD-week relay feedback (temporary, native in-app form): which 20-min relay block this was, e.g. "Block 1".';
comment on column public.attendance_sessions.relay_program_area is
  'PD-week relay feedback: program taught, matching the real reference Google Form''s exact choice text.';
comment on column public.attendance_sessions.relay_objective is
  'PD-week relay feedback: free-text answer to "What was your main objective/focus for this 20-min lesson?"';
comment on column public.attendance_sessions.relay_achieved_objective is
  'PD-week relay feedback: "Did you achieve your primary objective?" — exact choice text from the reference form.';
comment on column public.attendance_sessions.relay_objective_reflection is
  'PD-week relay feedback: free-text "Objective Reflection (Why or why not?)".';
comment on column public.attendance_sessions.relay_engagement_scale is
  'PD-week relay feedback: 1-5 linear scale, "Low Engagement / Passive" to "High Engagement / Active All-Play".';
comment on column public.attendance_sessions.relay_challenges is
  'PD-week relay feedback: multi-select checkboxes ("What was the biggest challenge or issue during this session?"), stored as the array of exact choice text selected.';
comment on column public.attendance_sessions.relay_pivots is
  'PD-week relay feedback: optional free-text "Reflection & Pivots" — the one optional question on the reference form.';

create or replace function public.close_session_with_relay_feedback(
  p_session_id uuid,
  p_relay_block text,
  p_program_area text,
  p_objective text,
  p_achieved_objective text,
  p_objective_reflection text,
  p_engagement_scale smallint,
  p_challenges text[],
  p_pivots text default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit feedback.';
  end if;

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found or v_row.teacher_id <> v_uid then
    raise exception 'That clock-in session could not be found.';
  end if;
  if v_row.clock_out_at is not null then
    raise exception 'You have already clocked out of this class.';
  end if;

  if p_relay_block is null or btrim(p_relay_block) = '' then
    raise exception 'Please select the relay block.';
  end if;
  if p_program_area is null or btrim(p_program_area) = '' then
    raise exception 'Please select the program area.';
  end if;
  if p_objective is null or btrim(p_objective) = '' then
    raise exception 'Please describe your main objective for this lesson.';
  end if;
  if p_achieved_objective is null or btrim(p_achieved_objective) = '' then
    raise exception 'Please select whether you achieved your objective.';
  end if;
  if p_objective_reflection is null or btrim(p_objective_reflection) = '' then
    raise exception 'Please add an objective reflection.';
  end if;
  if p_engagement_scale is null or p_engagement_scale < 1 or p_engagement_scale > 5 then
    raise exception 'Please rate engagement from 1 to 5.';
  end if;
  if p_challenges is null or array_length(p_challenges, 1) is null then
    raise exception 'Please select at least one challenge option (or "None / Everything went smoothly").';
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         relay_block = p_relay_block,
         relay_program_area = p_program_area,
         relay_objective = btrim(p_objective),
         relay_achieved_objective = p_achieved_objective,
         relay_objective_reflection = btrim(p_objective_reflection),
         relay_engagement_scale = p_engagement_scale,
         relay_challenges = p_challenges,
         relay_pivots = nullif(btrim(coalesce(p_pivots, '')), ''),
         relay_feedback_submitted_at = now()
   where id = p_session_id
   returning * into v_row;

  -- Same auto-resolve as close_session_from_zoho (0021): harmless here since
  -- this path is synchronous (no external relay lag to get "stuck" on), but
  -- cheap insurance against a session that was flagged before this feature
  -- existed and is now being closed through it.
  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: relay feedback submitted in-app')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.close_session_with_relay_feedback(uuid, text, text, text, text, text, smallint, text[], text) from public, anon;
grant execute on function public.close_session_with_relay_feedback(uuid, text, text, text, text, text, smallint, text[], text) to authenticated;
