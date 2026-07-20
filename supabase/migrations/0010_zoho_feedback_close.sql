-- Product change (user-confirmed, post-Phase-4): feedback is no longer an
-- in-app form. The PRD calls for teachers to fill out a Zoho-hosted form
-- (embedded in the app); Zoho's own webhook, not the teacher's own client, is
-- what actually closes the attendance session. This replaces
-- clock_out_with_feedback (teacher-called, authenticated) with
-- close_session_from_zoho (service-role-only, called from the Next.js
-- webhook route handler after verifying a shared secret — see
-- src/app/api/zoho-feedback/route.ts). See DECISIONS.md for the full
-- rationale, including why the previous RPC is dropped rather than kept
-- alongside this one: the Zoho form is now the ONLY place feedback is
-- captured, so there is no second, in-app path left to gate.
--
-- The open-session invariant is unchanged: clock_out_at IS NULL still means
-- the session is open and blocks the next clock-in (clock_in() is untouched
-- by this migration). Only *how* clock_out_at gets set changes.

drop function if exists public.clock_out_with_feedback(uuid, integer, text, text, integer);

-- close_session_from_zoho: the only remaining way to close a session.
-- Deliberately NOT security definer and NOT granted to authenticated/anon —
-- it runs as service_role (which already bypasses RLS and holds `grant all`
-- on this table), called only by our webhook handler after verifying Zoho's
-- shared secret out-of-band. A teacher's own JWT can never reach this
-- function, which is the point: closing a session now requires proof Zoho
-- actually received a submission, not just a client claiming to submit one.
--
-- Idempotent: webhooks retry. If the session is already closed, this
-- returns the existing (unchanged) row instead of raising, so a duplicate
-- delivery is a harmless no-op rather than a surfaced error.
create or replace function public.close_session_from_zoho(
  p_session_id uuid,
  p_rating integer,
  p_summary text,
  p_challenges text default null,
  p_students_present integer default null
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
    return v_row; -- already closed; treat a retried webhook delivery as a no-op success.
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5.';
  end if;
  if p_summary is null or btrim(p_summary) = '' then
    raise exception 'Summary is required.';
  end if;
  if p_students_present is not null and p_students_present < 0 then
    raise exception 'Students present can''t be negative.';
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         feedback_rating = p_rating,
         feedback_summary = btrim(p_summary),
         feedback_challenges = nullif(btrim(coalesce(p_challenges, '')), ''),
         feedback_students_present = p_students_present,
         feedback_submitted_at = now()
   where id = p_session_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_zoho(uuid, integer, text, text, integer) from public, anon, authenticated;
grant execute on function public.close_session_from_zoho(uuid, integer, text, text, integer) to service_role;

comment on table public.attendance_sessions is
  'One clock-in -> clock-out cycle. clock_out_at IS NULL means the session is open and feedback is owed; that open row is the blocking "Demand" (no separate table). clock_in() (authenticated) opens it; close_session_from_zoho() (service_role only, called by the Zoho feedback webhook) is the only thing that closes it.';
