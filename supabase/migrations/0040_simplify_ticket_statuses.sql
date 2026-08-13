-- Five ticket statuses instead of seven (YMU, 2026-08-13).
--
--   Open · In_Progress · Escalated · On_Hold · Closed
--
-- `Resolved` and `Closed` were the same act described twice. YMU never used the
-- distinction and could not say what it meant, which is the honest test for
-- whether a state earns its place. Closed now does what Resolved did — it
-- stamps resolved_at, and it still demands a root cause, because that field is
-- the only input to the PD-planning aggregate and nobody reconstructs it a week
-- later.
--
-- `Pending_Teacher` also goes. Two things it carried have to land somewhere,
-- and this is the part worth reading before assuming this migration is
-- cosmetic:
--
--   1. IT PAUSED THE SLA CLOCK. Migration 0031 exists largely for this: an
--      agent must not be marked late for time spent waiting on someone else.
--      `On_Hold` already pauses identically, so the capability survives — the
--      resume-on-teacher-reply trigger is repointed to it, and an agent waiting
--      on a teacher now uses On_Hold.
--   2. IT PINGED THE TEACHER (`ticket_needs_you`). That notification is gone
--      with the status. On_Hold does NOT inherit it, deliberately: most holds
--      are waiting on a part, a school or a decision, and pushing "we need you"
--      at a teacher every time would train them to ignore it. Asking a teacher
--      for something is now a message on the ticket, which they are notified
--      about anyway.
--
-- No data migration is needed — production holds one Open, one Escalated and
-- one Closed — but the UPDATEs below run anyway so this is safe to replay
-- against any database.
--
-- DELIBERATELY NOT TOUCHED: `ticket_sla`, `agent_ticket_metrics` and
-- `detect_unanswered_tickets` each test `status not in ('Resolved', 'Closed')`.
-- Once the CHECK below makes 'Resolved' unreachable that predicate is exactly
-- equivalent to `status <> 'Closed'`, so all three are already correct.
-- Rewriting three live functions to delete a dead string is the kind of tidying
-- that reverts someone's drifted fix by accident — the same trap that nearly
-- bit the email migration next door. The stale literal is harmless; note it
-- here and leave them alone.

-- Existing rows first: the CHECK cannot narrow while a row still violates it.
update public.tickets set status = 'In_Progress' where status = 'Pending_Teacher';
update public.tickets
   set status = 'Closed',
       closed_at = coalesce(closed_at, resolved_at, now())
 where status = 'Resolved';

alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets add constraint tickets_status_check
  check (status in ('Open', 'In_Progress', 'Escalated', 'On_Hold', 'Closed'));

-- ===========================================================================
-- set_ticket_status: Closed absorbs Resolved
-- ===========================================================================

create or replace function public.set_ticket_status(
  p_ticket_id uuid,
  p_status text,
  p_root_cause_category text default null,
  p_note text default null
)
returns public.tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.current_app_role();
  v_ticket public.tickets;
  v_was_closed boolean;
  v_pausing boolean;
  v_accrued integer := 0;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id;
  if not found then
    raise exception 'That ticket could not be found.';
  end if;

  if not (
    v_ticket.assigned_agent_id = v_uid
    or v_role in ('operations_manager', 'cpo', 'academic_manager')
    or (v_role = 'regional_manager' and v_ticket.region = public.current_app_region())
  ) then
    raise exception 'Only a manager can change this ticket''s status.';
  end if;

  if p_status not in ('Open','In_Progress','Escalated','On_Hold','Closed') then
    raise exception 'Unknown ticket status.';
  end if;

  -- The root-cause requirement moves from Resolved to Closed with the meaning.
  if p_status = 'Closed' and coalesce(nullif(btrim(coalesce(p_root_cause_category, v_ticket.root_cause_category, '')), ''), '') = '' then
    raise exception 'Choose a root cause before closing this ticket.';
  end if;

  v_was_closed := v_ticket.status = 'Closed';
  v_pausing := p_status = 'On_Hold';

  -- Leaving a paused state banks the elapsed minutes.
  if v_ticket.sla_paused_since is not null and not v_pausing then
    v_accrued := floor(extract(epoch from (now() - v_ticket.sla_paused_since)) / 60)::integer;
  end if;

  update public.tickets
     set status = p_status,
         root_cause_category = coalesce(nullif(btrim(coalesce(p_root_cause_category, '')), ''), root_cause_category),
         first_response_at = coalesce(first_response_at,
           case when p_status <> 'Open' then now() end),
         -- resolved_at still exists and still means "the clock stopped" — the
         -- SLA view computes TTR from it. Closing is now the only thing that
         -- stops it, and re-opening clears it, exactly as before.
         resolved_at = case when p_status = 'Closed' then coalesce(resolved_at, now())
                            else null end,
         closed_at = case when p_status = 'Closed' then coalesce(closed_at, now())
                          else null end,
         sla_paused_minutes = sla_paused_minutes + v_accrued,
         -- Re-entering a pause already running must not reset it.
         sla_paused_since = case
           when v_pausing then coalesce(sla_paused_since, now())
           else null
         end,
         reopen_count = reopen_count + case when v_was_closed and p_status = 'Open' then 1 else 0 end,
         updated_at = now()
   where id = p_ticket_id
   returning * into v_ticket;

  insert into public.ticket_messages (ticket_id, sender_id, message_body, is_internal_note, resulting_status)
  values (
    p_ticket_id, v_uid,
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Status changed to ' || p_status),
    true, p_status
  );

  -- The teacher is told when their ticket is finished. `ticket_needs_you` went
  -- with Pending_Teacher — see the header.
  if p_status = 'Closed' then
    insert into public.notification_queue (recipient_id, event_id, type, payload)
    values (
      v_ticket.teacher_id, v_ticket.event_id, 'ticket_resolved',
      jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket.ticket_number)
    );
  end if;

  return v_ticket;
end;
$$;

revoke execute on function public.set_ticket_status(uuid, text, text, text) from public, anon;
grant execute on function public.set_ticket_status(uuid, text, text, text) to authenticated;

-- ===========================================================================
-- The teacher's reply still resumes the clock — now from On_Hold
-- ===========================================================================

create or replace function public.resume_sla_on_teacher_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.tickets;
begin
  if new.is_internal_note then
    return new;
  end if;

  select * into v_ticket from public.tickets where id = new.ticket_id;
  -- Was Pending_Teacher. On_Hold is now the state an agent uses while waiting
  -- on someone, so a teacher answering it is still what un-pauses the clock —
  -- without this the pause would keep accruing overnight and quietly flatter
  -- the agent's numbers, which is the exact bug 0031 called out.
  if not found or v_ticket.status <> 'On_Hold' or new.sender_id <> v_ticket.teacher_id then
    return new;
  end if;

  update public.tickets
     set status = 'In_Progress',
         sla_paused_minutes = sla_paused_minutes
           + coalesce(floor(extract(epoch from (now() - sla_paused_since)) / 60)::integer, 0),
         sla_paused_since = null,
         updated_at = now()
   where id = new.ticket_id;

  if v_ticket.assigned_agent_id is not null then
    insert into public.notification_queue (recipient_id, event_id, type, payload)
    values (
      v_ticket.assigned_agent_id, v_ticket.event_id, 'ticket_teacher_replied',
      public.manager_notification_payload(v_ticket.teacher_id, v_ticket.school_id, v_ticket.event_id)
        || jsonb_build_object('ticket_id', v_ticket.id, 'ticket_number', v_ticket.ticket_number,
                              'category_type', v_ticket.category_type)
    );
  end if;

  return new;
end;
$$;
