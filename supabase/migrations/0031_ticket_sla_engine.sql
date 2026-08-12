-- The SLA engine: clocks that actually run, pause, and breach.
--
-- 0030 recorded the timestamps but nothing read them. A ticket could sit for a
-- week and look identical to one opened this morning. This makes the waiting
-- visible and, more importantly, makes something happen when nobody answers.
--
-- Every number is computed in SQL, never in the client. PRD 4.3 is explicit
-- about why: an agent and an Admin looking at the same ticket must see the
-- same figure, and two implementations of "how long has this been open" drift
-- the moment one of them is edited.

-- ---------------------------------------------------------------------------
-- 1. Pause accounting
--
-- sla_paused_minutes existed since 0030 but nothing ever incremented it.
-- Accruing it needs a second field: the moment the current pause began.
-- Without it you can only ever know the total AFTER a pause ends, so a ticket
-- sitting in Pending_Teacher right now would report zero paused time and look
-- like the agent was sitting on it.
-- ---------------------------------------------------------------------------

alter table public.tickets add column sla_paused_since timestamptz;

comment on column public.tickets.sla_paused_since is
  'When the current Pending_Teacher / On_Hold stretch began, or null if the clock is running. Needed so a ticket paused RIGHT NOW reports its pause instead of looking neglected.';

-- Targets from PRD 4.3. Kept in SQL rather than TypeScript because the
-- breach calculation happens here and a second copy would drift.
create or replace function public.ticket_ttr_target_hours(p_priority text)
returns integer
language sql
immutable
as $$
  select case p_priority
    when 'Urgent' then 4
    when 'High' then 24
    else 72
  end;
$$;

-- First response target is flat: PRD 4.3 ties it to YMU's own 24-Hour Rule
-- rather than to priority.
create or replace function public.ticket_frt_target_hours()
returns integer language sql immutable as $$ select 24; $$;

-- ---------------------------------------------------------------------------
-- 2. The view every SLA surface reads
--
-- security_invoker so it inherits tickets_select — a Regional Manager querying
-- it sees exactly their region, with no second authorization rule to keep in
-- sync. Same approach as attendance_period_rows (0016).
-- ---------------------------------------------------------------------------

create or replace view public.ticket_sla
with (security_invoker = true) as
select
  t.id,
  t.ticket_number,
  t.teacher_id,
  t.school_id,
  t.region,
  t.category_type,
  t.priority_level,
  t.status,
  t.root_cause_category,
  t.assigned_agent_id,
  t.created_at,
  t.first_response_at,
  t.resolved_at,
  t.closed_at,
  t.reopen_count,

  -- Total paused time, INCLUDING a pause still in progress.
  (t.sla_paused_minutes
    + case when t.sla_paused_since is null then 0
           else floor(extract(epoch from (now() - t.sla_paused_since)) / 60) end
  )::integer as paused_minutes,

  -- First response: how long the teacher waited for a human. Null while still
  -- waiting, so "no response yet" and "responded instantly" never collapse
  -- into the same number.
  case when t.first_response_at is null then null
       else floor(extract(epoch from (t.first_response_at - t.created_at)) / 60)::integer
  end as frt_minutes,

  -- Minutes the FRT clock has been running for a ticket nobody has answered.
  case when t.first_response_at is not null then null
       else floor(extract(epoch from (now() - t.created_at)) / 60)::integer
  end as awaiting_response_minutes,

  -- Total elapsed to resolution, and the same figure minus time the agent was
  -- legitimately blocked. PRD 4.3 calls the second one Effective Resolution
  -- Time; it is the one to judge an agent by.
  case when t.resolved_at is null then null
       else floor(extract(epoch from (t.resolved_at - t.created_at)) / 60)::integer
  end as ttr_minutes,
  case when t.resolved_at is null then null
       else greatest(0, floor(extract(epoch from (t.resolved_at - t.created_at)) / 60)::integer
              - t.sla_paused_minutes)
  end as effective_ttr_minutes,

  -- Age of an unresolved ticket, excluding pauses — what the breach test uses.
  case when t.resolved_at is not null then null
       else greatest(0, floor(extract(epoch from (now() - t.created_at)) / 60)::integer
              - (t.sla_paused_minutes
                 + case when t.sla_paused_since is null then 0
                        else floor(extract(epoch from (now() - t.sla_paused_since)) / 60) end)::integer)
  end as open_active_minutes,

  public.ticket_ttr_target_hours(t.priority_level) as ttr_target_hours,

  -- on_track / warning / breached, plus 'met' and 'missed' once it's done.
  -- Warning starts at 75% of the target, which is late enough to mean
  -- something and early enough to still act on.
  case
    when t.resolved_at is not null then
      case when floor(extract(epoch from (t.resolved_at - t.created_at)) / 60) - t.sla_paused_minutes
                <= public.ticket_ttr_target_hours(t.priority_level) * 60
           then 'met' else 'missed' end
    else
      case
        when greatest(0, floor(extract(epoch from (now() - t.created_at)) / 60)
               - (t.sla_paused_minutes
                  + case when t.sla_paused_since is null then 0
                         else floor(extract(epoch from (now() - t.sla_paused_since)) / 60) end))
             > public.ticket_ttr_target_hours(t.priority_level) * 60
        then 'breached'
        when greatest(0, floor(extract(epoch from (now() - t.created_at)) / 60)
               - (t.sla_paused_minutes
                  + case when t.sla_paused_since is null then 0
                         else floor(extract(epoch from (now() - t.sla_paused_since)) / 60) end))
             > public.ticket_ttr_target_hours(t.priority_level) * 60 * 0.75
        then 'warning'
        else 'on_track'
      end
  end as sla_state,

  -- The PRD's "SLA Overdue / Unanswered" tab is exactly this flag: open, and
  -- nobody has replied within the 24-hour first-response target.
  (t.first_response_at is null
    and t.status not in ('Resolved', 'Closed')
    and now() > t.created_at + make_interval(hours => public.ticket_frt_target_hours())
  ) as unanswered_overdue
from public.tickets t;

grant select on public.ticket_sla to authenticated;

comment on view public.ticket_sla is
  'Every SLA figure, computed once in SQL so an agent and an Admin never see different numbers (PRD 4.3). security_invoker, so it inherits tickets_select rather than restating authorization.';

-- ---------------------------------------------------------------------------
-- 3. set_ticket_status now drives the pause clock
-- ---------------------------------------------------------------------------

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

  if p_status not in ('Open','In_Progress','Pending_Teacher','Escalated','On_Hold','Resolved','Closed') then
    raise exception 'Unknown ticket status.';
  end if;

  if p_status = 'Resolved' and coalesce(nullif(btrim(coalesce(p_root_cause_category, v_ticket.root_cause_category, '')), ''), '') = '' then
    raise exception 'Choose a root cause before resolving this ticket.';
  end if;

  v_was_closed := v_ticket.status in ('Resolved', 'Closed');
  v_pausing := p_status in ('Pending_Teacher', 'On_Hold');

  -- Leaving a paused state banks the elapsed minutes. Done here rather than in
  -- a trigger so the arithmetic sits next to the transition that causes it.
  if v_ticket.sla_paused_since is not null and not v_pausing then
    v_accrued := floor(extract(epoch from (now() - v_ticket.sla_paused_since)) / 60)::integer;
  end if;

  update public.tickets
     set status = p_status,
         root_cause_category = coalesce(nullif(btrim(coalesce(p_root_cause_category, '')), ''), root_cause_category),
         first_response_at = coalesce(first_response_at,
           case when p_status <> 'Open' then now() end),
         resolved_at = case when p_status = 'Resolved' then coalesce(resolved_at, now())
                            when p_status in ('Open','In_Progress','Pending_Teacher','Escalated','On_Hold') then null
                            else resolved_at end,
         closed_at = case when p_status = 'Closed' then now()
                          when p_status <> 'Resolved' then null
                          else closed_at end,
         sla_paused_minutes = sla_paused_minutes + v_accrued,
         -- Entering a pause starts the stopwatch; re-entering one that is
         -- already running must not reset it, or a bounce between
         -- Pending_Teacher and On_Hold would erase the wait.
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

  if p_status in ('Pending_Teacher', 'Resolved') then
    insert into public.notification_queue (recipient_id, event_id, type, payload)
    values (
      v_ticket.teacher_id, v_ticket.event_id,
      case when p_status = 'Pending_Teacher' then 'ticket_needs_you' else 'ticket_resolved' end,
      jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket.ticket_number)
    );
  end if;

  return v_ticket;
end;
$$;

revoke execute on function public.set_ticket_status(uuid, text, text, text) from public, anon;
grant execute on function public.set_ticket_status(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A teacher replying resumes the clock
--
-- PRD 3.2: Pending_Teacher pauses TTR so an agent is not penalised for the
-- teacher's delay — which means it has to RESUME the moment the teacher
-- answers. Left to a manual status change, the pause would keep accruing
-- overnight and quietly flatter the agent's numbers.
-- ---------------------------------------------------------------------------

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
  if not found or v_ticket.status <> 'Pending_Teacher' or new.sender_id <> v_ticket.teacher_id then
    return new;
  end if;

  update public.tickets
     set status = 'In_Progress',
         sla_paused_minutes = sla_paused_minutes
           + coalesce(floor(extract(epoch from (now() - sla_paused_since)) / 60)::integer, 0),
         sla_paused_since = null,
         updated_at = now()
   where id = new.ticket_id;

  -- The assignee needs to know the ball is back in their court.
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

create trigger ticket_messages_resume_sla
  after insert on public.ticket_messages
  for each row execute function public.resume_sla_on_teacher_reply();

-- ---------------------------------------------------------------------------
-- 5. The 24-hour unanswered sweep
--
-- The one piece with real teeth: without it a ticket can be forgotten
-- silently, which is exactly what YMU is leaving Zoho Desk to stop.
-- Escalates to the Academic Manager (then CPO/OM) rather than nagging the
-- assignee who has already ignored it for a day.
-- ---------------------------------------------------------------------------

create or replace function public.detect_unanswered_tickets()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_escalate_to uuid;
  v_count integer := 0;
begin
  select p.id into v_escalate_to from public.profiles p
  where p.role in ('academic_manager', 'cpo', 'operations_manager') and p.archived_at is null
  order by case p.role when 'academic_manager' then 0 when 'cpo' then 1 else 2 end, p.created_at
  limit 1;

  for v_row in
    select t.id, t.ticket_number, t.teacher_id, t.school_id, t.event_id,
           t.assigned_agent_id, t.category_type
    from public.tickets t
    where t.first_response_at is null
      and t.status not in ('Resolved', 'Closed')
      and now() > t.created_at + make_interval(hours => public.ticket_frt_target_hours())
      -- Once per ticket. The queue's own uniqueness only covers the three
      -- reminder types, so this is what stops an hourly re-nag.
      and not exists (
        select 1 from public.notification_queue nq
        where nq.type = 'ticket_sla_breach'
          and nq.payload->>'ticket_id' = t.id::text
      )
  loop
    v_count := v_count + 1;

    if v_row.assigned_agent_id is not null then
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_row.assigned_agent_id, v_row.event_id, 'ticket_sla_breach',
        public.manager_notification_payload(v_row.teacher_id, v_row.school_id, v_row.event_id)
          || jsonb_build_object('ticket_id', v_row.id, 'ticket_number', v_row.ticket_number,
                                'category_type', v_row.category_type)
      );
    end if;

    if v_escalate_to is not null and v_escalate_to is distinct from v_row.assigned_agent_id then
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_escalate_to, v_row.event_id, 'ticket_sla_breach',
        public.manager_notification_payload(v_row.teacher_id, v_row.school_id, v_row.event_id)
          || jsonb_build_object('ticket_id', v_row.id, 'ticket_number', v_row.ticket_number,
                                'category_type', v_row.category_type, 'escalated', true)
      );
    end if;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.detect_unanswered_tickets() from public, anon, authenticated;
grant execute on function public.detect_unanswered_tickets() to service_role;
