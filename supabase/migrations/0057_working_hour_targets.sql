-- Re-scale the resolution targets now that they mean working hours.
--
-- 0055 switched every SLA duration to working minutes (Mon-Fri 08:00-17:00)
-- but deliberately left the target NUMBERS alone, so they quietly stretched:
-- Normal's 72 stopped meaning three days and started meaning eight working
-- days, which is not a target anybody would set on purpose.
--
-- Restated so each one is a round number of working days (YMU 2026-08-17):
--
--   Urgent   4h  -> same working day
--   High     9h  -> one working day
--   Normal  27h  -> three working days
--
-- The nine-hour working day is what makes these read cleanly; it is the same
-- 08:00-17:00 window business_minutes_between() counts.

create or replace function public.ticket_ttr_target_hours(p_priority text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_priority
    when 'Urgent' then 4   -- same working day
    when 'High' then 9     -- one working day
    else 27                -- three working days
  end;
$$;

comment on function public.ticket_ttr_target_hours(text) is
  'Resolution target in WORKING hours (Mon-Fri 08:00-17:00, nine hours a day): Urgent 4h = same day, High 9h = one working day, Normal 27h = three working days. Mirrored for display only in TTR_TARGET_HOURS (src/lib/tickets/status.ts) — this is where the breach decision is actually made.';

-- Unchanged at 24 working hours, which is about two and a half working days to
-- acknowledge a ticket. Left alone because it was not part of the decision, but
-- flagged here as the obvious next thing to look at: it is what drives
-- detect_unanswered_tickets(), so nobody is chased for nearly three days.
comment on function public.ticket_frt_target_hours() is
  'First-response target in WORKING hours (Mon-Fri 08:00-17:00). 24 working hours is ~2.5 working days, which is slow for an acknowledgement — a shorter target (9h, one working day) is worth considering.';
