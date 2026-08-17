-- Ticket SLAs in working hours, and Escalated stops the clock.
--
-- Two problems, both reported after the first weekend of the pilot.
--
-- 1. THE CLOCK RAN THROUGH THE WEEKEND. Every deadline was wall-clock
--    `make_interval(hours => 24)`. A ticket raised Friday 3pm was "unanswered"
--    by Saturday 3pm and, come Monday morning, 65 hours old — a Normal ticket
--    (72h) all but breached without one working hour having passed. Managers
--    were being measured on time nobody was at work.
--
-- 2. ESCALATED DID NOT PAUSE. Escalated in practice means "the school has to
--    fix this and we cannot", but only On_Hold ever stopped the clock, so a
--    ticket waiting on a school was recorded as YMU missing its target. A
--    manager who escalates is not going to think "I should also set this to
--    On_Hold" — and shouldn't have to.
--
-- Working week per YMU (2026-08-17): Monday to Friday, 08:00-17:00
-- America/New_York. Nine hours a day, forty-five a week.
--
-- IMPORTANT CONSEQUENCE, deliberately left for YMU to judge: the target
-- NUMBERS are unchanged but now mean working hours, so they stretch in real
-- time. Urgent 4h is still same-day. High 24h becomes about two and a half
-- working days. Normal 72h becomes EIGHT working days, which is likely too
-- generous — see the note on ticket_ttr_target_hours below.

-- ---------------------------------------------------------------------------
-- Counting working minutes
-- ---------------------------------------------------------------------------

create or replace function public.business_minutes_between(
  p_from timestamptz,
  p_to timestamptz
)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_total numeric := 0;
  v_from timestamptz;
  v_to timestamptz;
  v_day date;
  v_last_day date;
  v_open timestamptz;
  v_close timestamptz;
  v_guard integer := 0;
begin
  if p_from is null or p_to is null then return null; end if;
  -- Tolerate a reversed pair rather than returning a negative: callers pass
  -- (created_at, resolved_at) and a clock skew should not read as -3 hours.
  v_from := least(p_from, p_to);
  v_to := greatest(p_from, p_to);

  v_day := (v_from at time zone 'America/New_York')::date;
  v_last_day := (v_to at time zone 'America/New_York')::date;

  while v_day <= v_last_day loop
    -- A runaway loop here would hold a lock on every ticket read. 800 days is
    -- far beyond any real ticket and still cheap.
    v_guard := v_guard + 1;
    exit when v_guard > 800;

    -- isodow: 1 = Monday … 7 = Sunday.
    if extract(isodow from v_day) <= 5 then
      v_open := (v_day + time '08:00') at time zone 'America/New_York';
      v_close := (v_day + time '17:00') at time zone 'America/New_York';
      v_total := v_total + greatest(
        0,
        extract(epoch from (least(v_to, v_close) - greatest(v_from, v_open))) / 60
      );
    end if;

    v_day := v_day + 1;
  end loop;

  return floor(v_total)::integer;
end;
$$;

comment on function public.business_minutes_between(timestamptz, timestamptz) is
  'Minutes between two instants that fall inside YMU''s working week: Mon-Fri 08:00-17:00 America/New_York. Every ticket SLA is measured with this, so a Friday-afternoon ticket is not most of the way to breached by Monday morning.';

grant execute on function public.business_minutes_between(timestamptz, timestamptz) to authenticated, service_role;

-- Named so the working week is stated once and can be moved in one place.
create or replace function public.business_day_start_hour() returns integer
  language sql immutable set search_path = '' as $$ select 8; $$;
create or replace function public.business_day_end_hour() returns integer
  language sql immutable set search_path = '' as $$ select 17; $$;

comment on function public.business_day_start_hour() is
  'Documents the working day used by business_minutes_between(). Changing this alone does NOT move the window — the hours are inlined there for the planner; change both.';

grant execute on function public.business_day_start_hour() to authenticated;
grant execute on function public.business_day_end_hour() to authenticated;

comment on function public.ticket_ttr_target_hours(text) is
  'Resolution target in WORKING hours (Mon-Fri 08:00-17:00), not wall clock. At nine hours a day that is: Urgent 4h = same day, High 24h ~ 2.5 working days, Normal 72h ~ 8 working days. The Normal figure is inherited from the wall-clock era and is worth revisiting.';

comment on function public.ticket_frt_target_hours() is
  'First-response target in WORKING hours (Mon-Fri 08:00-17:00). 24 working hours is about two and a half working days.';

-- ---------------------------------------------------------------------------
-- The view
-- ---------------------------------------------------------------------------
-- Same columns as before so nothing downstream breaks; every duration now
-- counts working minutes. paused_minutes included: set_ticket_status accrues
-- paused time in working minutes too (below), so the units match.

create or replace view public.ticket_sla
with (security_invoker = true) as
  select
    id,
    ticket_number,
    teacher_id,
    school_id,
    region,
    category_type,
    priority_level,
    status,
    root_cause_category,
    assigned_agent_id,
    created_at,
    first_response_at,
    resolved_at,
    closed_at,
    reopen_count,
    (
      sla_paused_minutes
      + case
          when sla_paused_since is null then 0
          else coalesce(public.business_minutes_between(sla_paused_since, now()), 0)
        end
    )::integer as paused_minutes,
    case
      when first_response_at is null then null::integer
      else public.business_minutes_between(created_at, first_response_at)
    end as frt_minutes,
    case
      when first_response_at is not null then null::integer
      else public.business_minutes_between(created_at, now())
    end as awaiting_response_minutes,
    case
      when resolved_at is null then null::integer
      else public.business_minutes_between(created_at, resolved_at)
    end as ttr_minutes,
    case
      when resolved_at is null then null::integer
      else greatest(
        0,
        public.business_minutes_between(created_at, resolved_at) - sla_paused_minutes
      )
    end as effective_ttr_minutes,
    case
      when resolved_at is not null then null::integer
      else greatest(
        0,
        public.business_minutes_between(created_at, now())
        - (
            sla_paused_minutes
            + case
                when sla_paused_since is null then 0
                else coalesce(public.business_minutes_between(sla_paused_since, now()), 0)
              end
          )
      )
    end as open_active_minutes,
    public.ticket_ttr_target_hours(priority_level) as ttr_target_hours,
    case
      when resolved_at is not null then
        case
          when greatest(0, public.business_minutes_between(created_at, resolved_at) - sla_paused_minutes)
               <= public.ticket_ttr_target_hours(priority_level) * 60
            then 'met'
          else 'missed'
        end
      else
        case
          when greatest(
                 0,
                 public.business_minutes_between(created_at, now())
                 - (
                     sla_paused_minutes
                     + case
                         when sla_paused_since is null then 0
                         else coalesce(public.business_minutes_between(sla_paused_since, now()), 0)
                       end
                   )
               ) > public.ticket_ttr_target_hours(priority_level) * 60
            then 'breached'
          when greatest(
                 0,
                 public.business_minutes_between(created_at, now())
                 - (
                     sla_paused_minutes
                     + case
                         when sla_paused_since is null then 0
                         else coalesce(public.business_minutes_between(sla_paused_since, now()), 0)
                       end
                   )
               ) > (public.ticket_ttr_target_hours(priority_level) * 60) * 0.75
            then 'warning'
          else 'on_track'
        end
    end as sla_state,
    -- Now that Escalated pauses, a paused ticket is never "overdue for a
    -- reply": the reply we are waiting for is not ours to give.
    (
      first_response_at is null
      and status not in ('Resolved', 'Closed')
      and sla_paused_since is null
      and coalesce(public.business_minutes_between(created_at, now()), 0)
          > public.ticket_frt_target_hours() * 60
    ) as unanswered_overdue,
    -- How long the ball has been in somebody else's court, in real days. NOT
    -- part of the SLA — it is the number that stops a ticket hiding in
    -- Escalated forever now that the clock stops there.
    case
      when sla_paused_since is null then null::integer
      else floor(extract(epoch from (now() - sla_paused_since)) / 86400)::integer
    end as waiting_days
  from public.tickets t;

comment on view public.ticket_sla is
  'Per-ticket SLA maths in WORKING minutes (Mon-Fri 08:00-17:00 America/New_York). On_Hold and Escalated both stop the clock; waiting_days reports the real elapsed wait so a paused ticket cannot hide.';

grant select on public.ticket_sla to authenticated;

-- ---------------------------------------------------------------------------
-- Escalated pauses, and paused time is counted in working minutes
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

  if p_status not in ('Open','In_Progress','Escalated','On_Hold','Closed') then
    raise exception 'Unknown ticket status.';
  end if;

  if p_status = 'Closed' and coalesce(nullif(btrim(coalesce(p_root_cause_category, v_ticket.root_cause_category, '')), ''), '') = '' then
    raise exception 'Choose a root cause before closing this ticket.';
  end if;

  v_was_closed := v_ticket.status = 'Closed';
  -- Escalated joins On_Hold. Escalating means the school (or someone outside
  -- YMU) has to act, and holding YMU to a deadline it cannot influence made
  -- the whole SLA number untrustworthy.
  v_pausing := p_status in ('On_Hold', 'Escalated');

  -- Working minutes, to match the units the view now measures everything in.
  if v_ticket.sla_paused_since is not null and not v_pausing then
    v_accrued := coalesce(
      public.business_minutes_between(v_ticket.sla_paused_since, now()),
      0
    );
  end if;

  update public.tickets
     set status = p_status,
         root_cause_category = coalesce(nullif(btrim(coalesce(p_root_cause_category, '')), ''), root_cause_category),
         first_response_at = coalesce(first_response_at,
           case when p_status <> 'Open' then now() end),
         resolved_at = case when p_status = 'Closed' then coalesce(resolved_at, now())
                            else null end,
         closed_at = case when p_status = 'Closed' then coalesce(closed_at, now())
                          else null end,
         sla_paused_minutes = sla_paused_minutes + v_accrued,
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

comment on function public.set_ticket_status(uuid, text, text, text) is
  'Changes a ticket''s status. On_Hold and Escalated both pause the SLA clock; leaving either banks the paused span in working minutes. Closing requires a root cause.';

revoke execute on function public.set_ticket_status(uuid, text, text, text) from public, anon;
grant execute on function public.set_ticket_status(uuid, text, text, text) to authenticated;

-- The teacher-reply auto-resume has to bank working minutes too, or a ticket
-- that sat On_Hold over a weekend would have three days of wall clock
-- subtracted from a working-hours total and read as resolved before it opened.
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
  if not found
     or v_ticket.status not in ('On_Hold', 'Escalated')
     or new.sender_id <> v_ticket.teacher_id then
    return new;
  end if;

  update public.tickets
     set status = 'In_Progress',
         sla_paused_minutes = sla_paused_minutes
           + coalesce(public.business_minutes_between(sla_paused_since, now()), 0),
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

-- ---------------------------------------------------------------------------
-- The unanswered sweep
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
      -- Working hours, so a Friday ticket is not chased on Saturday morning.
      and coalesce(public.business_minutes_between(t.created_at, now()), 0)
          > public.ticket_frt_target_hours() * 60
      -- A paused ticket is waiting on someone else; nagging our own manager
      -- about it is noise.
      and t.sla_paused_since is null
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

-- Tickets already sitting in Escalated predate the pause and have no
-- sla_paused_since, so their clocks are still running. Start them now rather
-- than back-dating a pause nobody recorded.
update public.tickets
   set sla_paused_since = now(),
       updated_at = now()
 where status = 'Escalated'
   and sla_paused_since is null;
