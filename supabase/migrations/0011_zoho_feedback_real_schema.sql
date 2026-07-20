-- Corrects the feedback columns/RPC to match the REAL Zoho form's fields,
-- discovered by reading the real form's rendered HTML (not guessed) after
-- 0010's schema turned out to be invented without ever seeing the form. The
-- real "TeacherFeedback" form asks for: student engagement (a 5-choice
-- scale, not a 1-5 rating), whether there was an issue (Yes/No), an issue
-- status (conditional free-choice, only if "Yes"), and optional notes. There
-- is no "students present" question and no free-text "summary" — see
-- DECISIONS.md for the full comparison against what 0010 assumed.
--
-- Safe to do as a destructive column change: only one row has ever existed
-- in attendance_sessions with any of the old feedback_* columns populated
-- (a still-open test session with none of them set), confirmed via
-- `select count(*) from attendance_sessions` before writing this migration.

alter table public.attendance_sessions
  drop column feedback_rating,
  drop column feedback_students_present;

alter table public.attendance_sessions
  rename column feedback_summary to feedback_notes;

alter table public.attendance_sessions
  add column feedback_engagement text,
  add column feedback_had_issue text,
  add column feedback_issue_status text,
  add constraint attendance_feedback_had_issue_check
    check (feedback_had_issue is null or feedback_had_issue in ('Yes', 'No'));

-- feedback_challenges was never actually used by the real form either; its
-- role is now feedback_issue_status (added above) + feedback_notes (renamed
-- from feedback_summary). Drop it rather than leave an unused column.
alter table public.attendance_sessions
  drop column feedback_challenges;

comment on column public.attendance_sessions.feedback_engagement is
  'Exact text of the Zoho form''s student-engagement choice (e.g. "Very engaged") — stored verbatim, not mapped to a number, per product decision.';
comment on column public.attendance_sessions.feedback_had_issue is
  '"Yes" or "No" — exact text from the Zoho form''s issue question.';
comment on column public.attendance_sessions.feedback_issue_status is
  'Exact text of the Zoho form''s issue-status choice; only present when feedback_had_issue = ''Yes''.';
comment on column public.attendance_sessions.feedback_notes is
  'Optional free-text notes/comments (instrument needs, repairs, etc.) from the Zoho form. Optional there too — do not require it here.';

drop function if exists public.close_session_from_zoho(uuid, integer, text, text, integer);

create or replace function public.close_session_from_zoho(
  p_session_id uuid,
  p_engagement text,
  p_had_issue text,
  p_issue_status text default null,
  p_notes text default null
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
    return v_row; -- already closed; a retried webhook delivery is a no-op success.
  end if;

  if p_engagement is null or btrim(p_engagement) = '' then
    raise exception 'Engagement is required.';
  end if;
  if p_had_issue is null or p_had_issue not in ('Yes', 'No') then
    raise exception 'Had issue must be Yes or No.';
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         feedback_engagement = btrim(p_engagement),
         feedback_had_issue = p_had_issue,
         feedback_issue_status = nullif(btrim(coalesce(p_issue_status, '')), ''),
         feedback_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         feedback_submitted_at = now()
   where id = p_session_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_zoho(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.close_session_from_zoho(uuid, text, text, text, text) to service_role;
