-- ===========================================================================
-- 0081 — some classes are not the kind you write a class report about
-- ===========================================================================
--
-- Reinaldo Velez's Tutoring block at Little River takes attendance and hands
-- out snacks. The feedback form asks which objectives were worked, how engaged
-- the students were, and whether the quarter goals are on track. There are no
-- objectives and there is no lesson. YMU (2026-08-21): "el tutoring no debería
-- tener feedback, o por lo menos no feedback de clases, porque ahí sólo pasa
-- lista y da los snacks."
--
-- Recorded as an assumption, not a fact: that description came with "si no me
-- equivoco". The list below is DATA, one row per pattern, so changing YMU's
-- mind is an insert or a delete rather than a migration.
--
-- ── Why a trigger and not an edit to clock_in() ───────────────────────────
--
-- Five things create an attendance_sessions row: clock_in() (0044),
-- admin_create_attendance() (0076), auto_attend_exempt_teachers() (0052),
-- auto_clock_in_back_to_back() (0077), and record_gps_check's offline sibling
-- via attempt_clock_in(). A rule enforced in one of five call sites is a rule
-- that will be wrong within a month — the same reasoning 0065 gives for
-- routing afterschool tickets with a trigger instead of editing
-- submit_class_feedback(). Here it holds for every insert, including any added
-- later.
--
-- ── What "exempt" means mechanically ─────────────────────────────────────
--
-- feedback_due_at = null and feedback_settled_at = now(), which is exactly
-- what auto_attend_exempt_teachers() does for an exempt teacher.
-- has_overdue_feedback() reads `feedback_settled_at is null and feedback_due_at
-- is not null`, so both halves are needed: the null due date keeps the session
-- out of the overdue count, and the settled stamp keeps it off the "pending
-- feedback" list. Without the second one an exempt class would sit at the top
-- of a teacher's demands forever with a form they are exempt from filling.
--
-- The session is still a full attendance record. Hours, the clock-in, the GPS
-- and the Reports row are all unchanged — this exempts the FORM, not the work.
-- ===========================================================================

create table if not exists public.feedback_exempt_patterns (
  id uuid primary key default gen_random_uuid(),
  -- Lowercase substring of the calendar title, matched the way
  -- afterschool_patterns (0063) and programs.match_patterns match: position()
  -- against lower(summary). Titles come from calendars the schools own, so
  -- matching a fragment is the only thing that survives their spelling.
  pattern text not null unique check (pattern = lower(btrim(pattern)) and length(pattern) >= 3),
  -- Why this kind of class has no lesson to report on. Read by whoever
  -- wonders in six months why Tutoring never appears in the feedback numbers.
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.feedback_exempt_patterns is
  'Title substrings marking a class that owes no feedback form. Sessions for a matching class are created already-settled, so they never appear as a demand. They are still full attendance records — this exempts the form, not the work.';

alter table public.feedback_exempt_patterns enable row level security;

-- Readable by everyone signed in: a teacher's own app has to be able to
-- explain why one class on their day asks for a form and another does not.
create policy feedback_exempt_patterns_select on public.feedback_exempt_patterns
  for select to authenticated using (true);

-- Writable by the two roles that set the other org-wide attendance policies
-- (clock_in_exempt in 0052, auto_clock_in_rules in 0077). Deciding a class
-- needs no report is the same kind of decision.
create policy feedback_exempt_patterns_write on public.feedback_exempt_patterns
  for all to authenticated
  using (public.current_app_role() in ('operations_manager', 'cpo'))
  with check (public.current_app_role() in ('operations_manager', 'cpo'));

insert into public.feedback_exempt_patterns (pattern, note) values
  ('tutoring',
   'Attendance and snacks, no lesson — there are no objectives to report against. YMU 2026-08-21.')
on conflict (pattern) do nothing;

-- ---------------------------------------------------------------------------
-- The predicate
-- ---------------------------------------------------------------------------

create or replace function public.class_owes_feedback(p_summary text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.feedback_exempt_patterns fep
     where fep.active
       and position(fep.pattern in lower(coalesce(p_summary, ''))) > 0
  );
$$;

comment on function public.class_owes_feedback(text) is
  'False when the class title matches an active feedback_exempt_patterns row. A null or empty title owes feedback — silence is not an exemption.';

grant execute on function public.class_owes_feedback(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------
-- BEFORE INSERT only. Deliberately not on UPDATE: a session that has already
-- collected real feedback must not lose it because somebody later added a
-- pattern that happens to match its title. New sessions follow the new rule;
-- history stays as it was recorded.

create or replace function public.settle_feedback_for_exempt_class()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_summary text;
begin
  -- Already settled by the caller (auto_attend_exempt_teachers does this for
  -- an exempt teacher). Nothing to add.
  if new.feedback_settled_at is not null then
    return new;
  end if;

  select ce.summary into v_summary
    from public.calendar_events ce
   where ce.id = new.event_id;

  if public.class_owes_feedback(v_summary) then
    return new;
  end if;

  new.feedback_due_at := null;
  new.feedback_settled_at := now();
  return new;
end;
$$;

drop trigger if exists attendance_sessions_settle_exempt_feedback on public.attendance_sessions;
create trigger attendance_sessions_settle_exempt_feedback
  before insert on public.attendance_sessions
  for each row execute function public.settle_feedback_for_exempt_class();

comment on function public.settle_feedback_for_exempt_class() is
  'Marks a new session as owing no feedback when its class title matches feedback_exempt_patterns. On INSERT only — adding a pattern later must not erase feedback already collected.';

-- ---------------------------------------------------------------------------
-- The sessions already sitting there
-- ---------------------------------------------------------------------------
-- Existing Tutoring sessions with an unmet feedback deadline are demands
-- nobody should ever have been asked to meet. Settle them, but only the ones
-- with NO feedback of their own — if a teacher did fill the form for a
-- Tutoring block, that answer is real and stays.

update public.attendance_sessions a
   set feedback_due_at = null,
       feedback_settled_at = coalesce(a.feedback_settled_at, now())
  from public.calendar_events ce
 where ce.id = a.event_id
   and not public.class_owes_feedback(ce.summary)
   and a.feedback_submitted_at is null
   and a.relay_feedback_submitted_at is null
   and not exists (
     select 1 from public.feedback_submissions f where f.session_id = a.id
   );
