-- Temporary parallel feedback-close path for this week's professional
-- development sessions, which use a plain Google Form ("YMU Teacher Relays –
-- Teacher Self-Reflection Form": teacher picks their own name/day/relay
-- block/program) instead of the paused Zoho form (see BUGS.md — the Zoho
-- webhook chain is parked, not fixed). This does NOT touch any Zoho code —
-- both paths coexist; NEXT_STEPS.md documents switching between them via
-- FEEDBACK_FORM_PROVIDER.
--
-- Session correlation works the same way it does for Zoho: two new
-- questions must be added to the real Google Form ("session_id" /
-- "teacher_id", short answer), prefilled by the app via Google Forms'
-- native entry.<id> URL-prefill mechanism (?entry.NNN=value), and an Apps
-- Script "On form submit" trigger relays the raw response to
-- /api/google-form-feedback. Unlike Zoho, Google's onFormSubmit trigger
-- hands the script the actual submitted item responses directly — there is
-- no separate "Payload Parameters" mapping step in Google's UI to
-- misconfigure, which was the unresolved suspect in the Zoho investigation.
--
-- The real form's questions (Teacher Name/Day/Relay Block/Program Area, plus
-- whatever reflection questions follow) are NOT the Zoho form's fixed
-- engagement/had_issue/issue_status/notes schema, so nothing is mapped
-- field-by-field — the whole submission is stored verbatim in a new jsonb
-- column instead.

alter table public.attendance_sessions
  add column feedback_raw jsonb,
  add column google_form_synced_at timestamptz;

comment on column public.attendance_sessions.feedback_raw is
  'Raw JSON of the Google Form response (temporary PD-week feedback path, close_session_from_google_form). This form''s questions are not the Zoho feedback_* fixed schema, so the whole submission is stored verbatim instead of mapped field-by-field.';
comment on column public.attendance_sessions.google_form_synced_at is
  'Set only when this session was closed by the Google Form relay (close_session_from_google_form). Mutually exclusive with zoho_synced_at/admin_closed_at — only one closing path ever runs per session.';

create or replace function public.close_session_from_google_form(
  p_session_id uuid,
  p_teacher_id uuid default null,
  p_raw_answers jsonb default null
)
returns public.attendance_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_row public.attendance_sessions;
begin
  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'No attendance session found for id %.', p_session_id;
  end if;

  if v_row.clock_out_at is not null then
    return v_row; -- already closed; a retried relay delivery is a no-op success.
  end if;

  -- Same IDOR defense as close_session_from_zoho's p_teacher_id: only
  -- enforced once the real form's teacher_id question is actually wired up
  -- and sending a valid value (null/invalid => skipped, matching Zoho's
  -- backward-compatible behavior).
  if p_teacher_id is not null and v_row.teacher_id <> p_teacher_id then
    raise exception 'Session % does not belong to teacher %.', p_session_id, p_teacher_id;
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         feedback_raw = p_raw_answers,
         feedback_submitted_at = now(),
         google_form_synced_at = now()
   where id = p_session_id
   returning * into v_row;

  -- Same auto-resolve as close_session_from_zoho (0021): a session that was
  -- flagged feedback_stuck and then legitimately closed via this relay
  -- shouldn't leave a stale escalation lingering on /flags.
  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: Google Form feedback received')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_google_form(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.close_session_from_google_form(uuid, uuid, jsonb) to service_role;
