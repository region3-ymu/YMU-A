-- First response: one working day.
--
-- 24 working hours was inherited from the wall-clock era and, once 0055 made
-- the clock count only Mon-Fri 08:00-17:00, it meant roughly two and a half
-- working days before anyone was told a ticket had gone unanswered. For an
-- acknowledgement — not a fix, just "we've seen it" — that is too long, and it
-- is the target that drives detect_unanswered_tickets() and the escalation to
-- the Academic Manager / CPO.
--
-- Nine working hours: one working day (YMU 2026-08-17). A ticket raised on
-- Monday morning is chased Tuesday morning, and one raised Friday afternoon is
-- chased Monday afternoon.
--
-- No notification storm from tightening it: detect_unanswered_tickets() fires
-- at most once per ticket, and both currently-unanswered tickets were already
-- notified under the old target. Ticket #1 does start showing as overdue in the
-- inbox, which is correct — it has had no reply in nearly two working days.

create or replace function public.ticket_frt_target_hours()
returns integer
language sql
immutable
set search_path = ''
as $$ select 9; $$;

comment on function public.ticket_frt_target_hours() is
  'First-response target in WORKING hours (Mon-Fri 08:00-17:00): 9h = one working day. Drives ticket_sla.unanswered_overdue and detect_unanswered_tickets(). An acknowledgement, not a resolution — ticket_ttr_target_hours() is the target for actually fixing it.';
