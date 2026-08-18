-- ===========================================================================
-- 0065 — the write side: routing, and the guards that read regions
-- ===========================================================================
--
-- 0064 changed who can SEE an afterschool class. On its own that does not
-- deliver what YMU asked for, and it leaves her unable to act on what she can
-- see. Two separate gaps:
--
--   1. tickets_select keeps `assigned_agent_id = auth.uid()` ahead of the
--      region split — deliberately, or a manager would lose a ticket handed to
--      them. But afterschool tickets are still ASSIGNED to the school's
--      Regional Manager by ticket_owner_for_school(), so every one of them
--      would stay in that RM's inbox no matter what the policy says.
--
--   2. Every SECURITY DEFINER action bypasses RLS and re-checks the region
--      itself. Those checks enumerate three roles, so she is refused by name,
--      and they let a Regional Manager act on an afterschool class they can no
--      longer even read.
--
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Afterschool tickets are hers, whoever opened them
-- ---------------------------------------------------------------------------
-- A trigger rather than an edit to submit_class_feedback(), because that is
-- not the only thing that inserts a ticket — the relay and Zoho paths do too,
-- and a rule enforced in one of three call sites is a rule that will be wrong
-- within a month. Here it holds for every insert, including any added later.
--
-- If no afterschool_manager profile exists yet, this leaves the RM as owner
-- rather than nulling the assignee: an owned ticket that is with the wrong
-- person still gets worked, an ownerless one raises a ticket_unassigned flag
-- and sits.

create or replace function public.route_afterschool_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if not public.afterschool_owned_event(new.event_id) then
    return new;
  end if;

  select p.id into v_owner
    from public.profiles p
   where p.role = 'afterschool_manager'
     and p.archived_at is null
   order by p.created_at
   limit 1;

  if v_owner is not null then
    new.assigned_agent_id := v_owner;
  end if;

  return new;
end;
$$;

comment on function public.route_afterschool_ticket() is
  'Overrides ticket_owner_for_school() for afterschool classes (YMU 2026-08-18). No-op while no afterschool_manager profile exists.';

drop trigger if exists tickets_route_afterschool on public.tickets;
create trigger tickets_route_afterschool
  before insert on public.tickets
  for each row execute function public.route_afterschool_ticket();

-- Existing open afterschool tickets move too, if she exists. Closed ones stay
-- with whoever closed them — reassigning history would rewrite who did the work.
update public.tickets t
   set assigned_agent_id = (
         select p.id from public.profiles p
          where p.role = 'afterschool_manager' and p.archived_at is null
          order by p.created_at limit 1
       ),
       updated_at = now()
 where t.status <> 'Closed'
   and public.afterschool_owned_event(t.event_id)
   and exists (
     select 1 from public.profiles p
      where p.role = 'afterschool_manager' and p.archived_at is null
   );

-- ---------------------------------------------------------------------------
-- 2. resolve_flag
-- ---------------------------------------------------------------------------

create or replace function public.resolve_flag(p_flag_id uuid, p_notes text default null)
returns public.flags
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_flag public.flags%rowtype;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if v_role not in ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager') then
    raise exception 'Only managers can resolve flags.';
  end if;

  select * into v_flag from public.flags where id = p_flag_id;
  if not found then
    raise exception 'Flag not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned_event(v_flag.event_id) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    if v_flag.school_id is not null and not exists (
      select 1 from public.schools s
      where s.id = v_flag.school_id and (s.region is null or s.region = public.current_app_region())
    ) then
      raise exception 'You can only resolve flags in your own region.';
    end if;
  elsif v_role = 'afterschool_manager' and not public.afterschool_owned_event(v_flag.event_id) then
    raise exception 'You can only resolve flags on afterschool classes.';
  end if;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = details || jsonb_build_object('resolution_notes', p_notes)
   where id = p_flag_id
   returning * into v_flag;

  return v_flag;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_edit_attendance / admin_create_attendance
-- ---------------------------------------------------------------------------
-- She needs both: an afterschool teacher who missed a clock-in is her problem
-- to reconcile now, and 0066's form is the one that calls these.

create or replace function public.admin_edit_attendance(
  p_session_id uuid,
  p_clock_in_status text default null,
  p_clock_in_at timestamptz default null,
  p_reason text default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_row public.attendance_sessions;
  v_school_region public.region;
begin
  if v_uid is null or v_role not in ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager') then
    raise exception 'Only a regional manager, the afterschool manager, operations manager, or the CPO can edit attendance.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to edit an attendance record.';
  end if;
  if p_clock_in_status is not null and p_clock_in_status not in ('on_time', 'late') then
    raise exception 'clock_in_status must be on_time or late.';
  end if;

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'Attendance session not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned_event(v_row.event_id) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_row.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only edit attendance for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager' and not public.afterschool_owned_event(v_row.event_id) then
    raise exception 'You can only edit attendance on afterschool classes.';
  end if;

  update public.attendance_sessions
     set clock_in_status = coalesce(p_clock_in_status, clock_in_status),
         clock_in_at = coalesce(p_clock_in_at, clock_in_at),
         admin_edited_at = now(),
         admin_edited_by = v_uid,
         admin_edit_reason = btrim(p_reason)
   where id = p_session_id
   returning * into v_row;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb)
           || jsonb_build_object('resolution_notes', 'Attendance corrected by manager: ' || btrim(p_reason))
   where type = 'late_clock_in'
     and event_id = v_row.event_id
     and teacher_id = v_row.teacher_id
     and resolved_at is null;

  return v_row;
end;
$$;

create or replace function public.admin_create_attendance(
  p_event_id uuid,
  p_teacher_id uuid,
  p_clock_in_at timestamptz,
  p_clock_in_status text,
  p_reason text
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_event public.calendar_events;
  v_school_region public.region;
  v_row public.attendance_sessions;
  v_clock_out timestamptz;
begin
  if v_uid is null or v_role not in ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager') then
    raise exception 'Only a regional manager, the afterschool manager, operations manager, or the CPO can record attendance.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to record a missed attendance.';
  end if;
  if p_clock_in_status not in ('on_time', 'late') then
    raise exception 'clock_in_status must be on_time or late.';
  end if;

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'Class not found.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_event.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only record attendance for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager'
    and not public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
    raise exception 'You can only record attendance on afterschool classes.';
  end if;

  if exists (
    select 1 from public.attendance_sessions
    where event_id = p_event_id and teacher_id = p_teacher_id
  ) then
    raise exception 'An attendance record already exists for this class/teacher - edit it instead.';
  end if;

  v_clock_out := case
    when v_event.end_at is not null and v_event.end_at <= now() then v_event.end_at
    else null
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id, clock_in_at, clock_in_status,
    scheduled_start_at, scheduled_end_at, feedback_due_at,
    clock_out_at, clock_out_source,
    origin, admin_edited_at, admin_edited_by, admin_edit_reason
  )
  values (
    p_teacher_id, p_event_id, v_event.school_id, p_clock_in_at, p_clock_in_status,
    v_event.start_at, v_event.end_at,
    case when v_event.end_at is null then null else v_event.end_at + interval '24 hours' end,
    v_clock_out,
    case when v_clock_out is null then null else 'admin' end,
    'admin', now(), v_uid, btrim(p_reason)
  )
  returning * into v_row;

  update public.flags
     set resolved_at = now(),
         resolved_by = v_uid,
         details = coalesce(details, '{}'::jsonb)
           || jsonb_build_object('resolution_notes', 'Recorded by manager: ' || btrim(p_reason))
   where type = 'late_clock_in'
     and event_id = p_event_id
     and teacher_id = p_teacher_id
     and resolved_at is null;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. set_ticket_status / reassign_ticket
-- ---------------------------------------------------------------------------
-- Only the authorization clause changes in each; the bodies are 0031/0030
-- verbatim. Note `assigned_agent_id = v_uid` stays first in both, so a ticket
-- deliberately handed to a Regional Manager stays workable by them — an
-- explicit reassignment is a decision, not a leak.

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
    or (
      v_role = 'regional_manager'
      and v_ticket.region = public.current_app_region()
      and not public.afterschool_owned_event(v_ticket.event_id)
    )
    or (
      v_role = 'afterschool_manager'
      and public.afterschool_owned_event(v_ticket.event_id)
    )
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
  v_pausing := p_status in ('On_Hold', 'Escalated');

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

create or replace function public.reassign_ticket(
  p_ticket_id uuid,
  p_new_agent_id uuid,
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
  v_new_role text;
  v_old_name text;
  v_new_name text;
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
    or (
      v_role = 'regional_manager'
      and v_ticket.region = public.current_app_region()
      and not public.afterschool_owned_event(v_ticket.event_id)
    )
    or (
      v_role = 'afterschool_manager'
      and public.afterschool_owned_event(v_ticket.event_id)
    )
  ) then
    raise exception 'Only a manager on this ticket can reassign it.';
  end if;

  select role::text, full_name into v_new_role, v_new_name
  from public.profiles where id = p_new_agent_id and archived_at is null;
  if v_new_role is null then
    raise exception 'That person could not be found.';
  end if;
  if v_new_role = 'teacher' then
    raise exception 'Tickets can only be assigned to a manager.';
  end if;

  if v_ticket.assigned_agent_id = p_new_agent_id then
    return v_ticket;
  end if;

  select full_name into v_old_name from public.profiles where id = v_ticket.assigned_agent_id;

  update public.tickets
     set assigned_agent_id = p_new_agent_id,
         updated_at = now()
   where id = p_ticket_id
   returning * into v_ticket;

  insert into public.ticket_messages (ticket_id, sender_id, message_body, is_internal_note)
  values (
    p_ticket_id, v_uid,
    'Reassigned from ' || coalesce(v_old_name, 'nobody') || ' to ' || v_new_name
      || case when nullif(btrim(coalesce(p_note, '')), '') is null then ''
              else ' — ' || btrim(p_note) end,
    true
  );

  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Ticket assigned to ' || v_new_name)
   where type = 'ticket_unassigned'
     and details->>'ticket_id' = p_ticket_id::text
     and resolved_at is null;

  insert into public.notification_queue (recipient_id, event_id, type, payload)
  values (
    p_new_agent_id, v_ticket.event_id, 'ticket_assigned',
    public.manager_notification_payload(v_ticket.teacher_id, v_ticket.school_id, v_ticket.event_id)
      || jsonb_build_object('ticket_id', p_ticket_id, 'category_type', v_ticket.category_type)
  );

  return v_ticket;
end;
$$;

-- ---------------------------------------------------------------------------
-- Still region-only, on purpose
-- ---------------------------------------------------------------------------
-- assign_event_school, resolve_calendar_issue, report_teacher_roster and
-- teacher_directory also read current_app_region(). /lists and /substitutes are
-- kept out of her nav for that reason (see navForRole), but /reports is linked
-- for every role, so report_teacher_roster() will come back empty for her — a
-- manager with no region matches no region. Empty, not leaky: widening these
-- four to the afterschool scope is the next piece of work, not a hole in this
-- one.
