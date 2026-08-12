-- Module A + the ticket spine: programs, the native feedback form, and tickets.
--
-- Replaces the Zoho Forms / Zoho Desk pair with tables in this database. The
-- moment to do it cleanly is now: 0025 wiped every attendance_sessions row, so
-- there is no feedback data to migrate and no dual-write period to survive.
--
-- Three deliberate departures from the PRD, all confirmed with YMU:
--
-- 1. ROUTING. The PRD (Module B) sends Academic/Curriculum tickets straight to
--    the Academic Manager, bypassing the region. YMU wants one path: every
--    ticket goes to the Regional Manager for the school's region.
--    category_type survives as a label for filtering and reporting, but never
--    changes the assignee. The Academic Manager reads everything instead.
--
-- 2. PROGRAM. The PRD assumes the shift already knows its program_id. It does
--    not — calendar_events has no program column and never has. But the Google
--    Calendar titles ARE the program names ("Drumline" x1685, "Music
--    Production" x1265, "Beginning Band" x984, "Modern Band" x870), so the
--    program is derived from the title and the teacher only corrects it when
--    the guess is wrong.
--
-- 3. FEEDBACK STORAGE. feedback_settled_at stops being a generated column.
--    0026 generated it over the three columns that existed then; with feedback
--    content moving to its own table, the honest thing is a plain timestamp
--    that every writer stamps. The 24-hour gate reads exactly the same
--    predicate either way.

-- ===========================================================================
-- 1. Programs and their topic chips
-- ===========================================================================

create table public.programs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- Drives which pillars/chips the form offers. PRD Section 2.2.
  category text not null check (category in ('Ensemble', 'Production', 'NonFixed')),
  -- Lowercase substrings matched against calendar_events.summary, most
  -- specific first. Text, not regex: these are maintained by staff, and a
  -- malformed regex would break clock-out for everyone.
  match_patterns text[] not null default '{}',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

comment on column public.programs.match_patterns is
  'Lowercase substrings matched against a class title to guess its program. Order across rows is by sort_order; the app tries the most specific pattern first so "marching band" wins over "band".';

create table public.program_topics (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id) on delete cascade,
  pillar_category text not null,
  topic_name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  unique (program_id, pillar_category, topic_name)
);

create index program_topics_program_idx on public.program_topics (program_id) where active;

alter table public.programs enable row level security;
alter table public.program_topics enable row level security;

-- Every signed-in user reads them; the form is useless otherwise. Writes stay
-- with OM/CPO, same as school_years.
grant select on table public.programs to authenticated;
grant select on table public.program_topics to authenticated;

create policy programs_select on public.programs
  for select to authenticated using (true);
create policy program_topics_select on public.program_topics
  for select to authenticated using (true);

create policy programs_write on public.programs
  for all to authenticated
  using (public.current_app_role() in ('operations_manager', 'cpo'))
  with check (public.current_app_role() in ('operations_manager', 'cpo'));
create policy program_topics_write on public.program_topics
  for all to authenticated
  using (public.current_app_role() in ('operations_manager', 'cpo'))
  with check (public.current_app_role() in ('operations_manager', 'cpo'));

grant insert, update, delete on table public.programs to authenticated;
grant insert, update, delete on table public.program_topics to authenticated;

-- ===========================================================================
-- 2. Tickets
-- ===========================================================================

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  -- Human-readable reference (#672 in the PRD). A sequence, not a count, so
  -- deleting a ticket never makes a later one reuse a number.
  ticket_number integer not null unique,
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  school_id uuid references public.schools (id) on delete set null,
  event_id uuid references public.calendar_events (id) on delete set null,
  session_id uuid references public.attendance_sessions (id) on delete set null,
  -- Denormalized for RBAC filtering without a join, exactly as gps_checks and
  -- clock_in_attempts already do.
  region public.region,
  category_type text not null check (category_type in ('Operational', 'Academic')),
  issue_subcategory text,
  priority_level text not null default 'Normal' check (priority_level in ('Urgent', 'High', 'Normal')),
  description text not null check (length(btrim(description)) >= 15),
  assigned_agent_id uuid references public.profiles (id) on delete set null,
  status text not null default 'Open' check (status in (
    'Open', 'In_Progress', 'Pending_Teacher', 'Escalated', 'On_Hold', 'Resolved', 'Closed'
  )),
  root_cause_category text check (root_cause_category in (
    'Curriculum_Pedagogy', 'Technology_Software', 'Facilities_Logistics',
    'Classroom_Mgmt_Safety', 'Payroll_Administrative'
  )),
  created_at timestamptz not null default now(),
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  sla_paused_minutes integer not null default 0,
  reopen_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create sequence public.ticket_number_seq owned by public.tickets.ticket_number;
alter table public.tickets alter column ticket_number set default nextval('public.ticket_number_seq');

create index tickets_assigned_idx on public.tickets (assigned_agent_id, status);
create index tickets_region_idx on public.tickets (region, status);
create index tickets_teacher_idx on public.tickets (teacher_id, created_at desc);

comment on table public.tickets is
  'Replaces Zoho Desk. Assignment is always School -> region -> that region''s Regional Manager (YMU 2026-08-12), falling back to CPO/OM when a region has none. category_type is a label for filtering, never a routing input.';

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  message_body text not null,
  channel text not null default 'Portal' check (channel in ('Portal', 'Email', 'Text', 'Verbal')),
  is_internal_note boolean not null default false,
  resulting_status text,
  created_at timestamptz not null default now()
);

create index ticket_messages_ticket_idx on public.ticket_messages (ticket_id, created_at);

-- ===========================================================================
-- 3. Feedback submissions
-- ===========================================================================

create table public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.attendance_sessions (id) on delete cascade,
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  school_id uuid references public.schools (id) on delete set null,
  event_id uuid references public.calendar_events (id) on delete set null,
  program_id uuid references public.programs (id) on delete set null,
  -- What the teacher actually taught, kept even when program_id is null so a
  -- class whose title matched nothing is still analysable.
  program_name_raw text,

  engagement_level text not null check (engagement_level in ('High', 'Solid', 'Low')),
  primary_focus_pillar text,
  specific_topic_ids uuid[] not null default '{}',
  open_topic_note text,
  quarter_goals_on_track boolean not null,
  has_issue boolean not null default false,
  submitted_at timestamptz not null default now()
);

create index feedback_submissions_teacher_idx on public.feedback_submissions (teacher_id, submitted_at desc);
create index feedback_submissions_program_idx on public.feedback_submissions (program_id, submitted_at desc);

-- ===========================================================================
-- 4. feedback_settled_at becomes a plain column
--
-- 0026 generated it from feedback_submitted_at / relay_feedback_submitted_at /
-- admin_closed_at. A fourth writer now exists and its content lives in another
-- table, which a generated column cannot see. Dropping the generated version
-- and backfilling from the same three sources keeps every reader — the 24-hour
-- gate, the owed list, the stuck detector — reading an identical predicate.
--
-- Safe to do unconditionally: attendance_sessions is empty (0025).
-- ===========================================================================

alter table public.attendance_sessions drop column feedback_settled_at;

alter table public.attendance_sessions add column feedback_settled_at timestamptz;

update public.attendance_sessions
   set feedback_settled_at = coalesce(feedback_submitted_at, relay_feedback_submitted_at, admin_closed_at)
 where feedback_settled_at is null;

comment on column public.attendance_sessions.feedback_settled_at is
  'When the feedback obligation was discharged, by any path. Plain column since 0030 — the native form records its content in feedback_submissions, which a generated column could not read.';

create index attendance_feedback_owed_idx
  on public.attendance_sessions (teacher_id, feedback_due_at)
  where feedback_settled_at is null;

-- The three pre-existing writers must now stamp it themselves.
create or replace function public.stamp_feedback_settled()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.feedback_settled_at is null then
    new.feedback_settled_at := coalesce(
      new.feedback_submitted_at, new.relay_feedback_submitted_at, new.admin_closed_at
    );
  end if;
  return new;
end;
$$;

comment on function public.stamp_feedback_settled() is
  'Keeps feedback_settled_at correct for the legacy Zoho/relay/admin-waiver paths without editing three RPCs. The native form sets it explicitly and this trigger leaves that value alone.';

create trigger attendance_stamp_feedback_settled
  before insert or update on public.attendance_sessions
  for each row execute function public.stamp_feedback_settled();

-- ===========================================================================
-- 5. Routing
-- ===========================================================================

create or replace function public.ticket_owner_for_school(p_school_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- The region's Regional Manager first. When that region has none, the
  -- Academic Manager catches it (YMU 2026-08-12) — east and west have no RM
  -- today and west holds 14 schools, so this is a live path, not a
  -- theoretical one. CPO/OM is the last resort so a ticket is never ownerless
  -- while any manager account exists.
  select coalesce(
    (
      select p.id from public.profiles p
      join public.schools s on s.id = p_school_id
      where p.role = 'regional_manager'
        and p.region = s.region
        and p.archived_at is null
      order by p.created_at
      limit 1
    ),
    (
      select p.id from public.profiles p
      where p.role = 'academic_manager' and p.archived_at is null
      order by p.created_at
      limit 1
    ),
    (
      select p.id from public.profiles p
      where p.role in ('cpo', 'operations_manager')
        and p.archived_at is null
      order by case p.role when 'cpo' then 0 else 1 end, p.created_at
      limit 1
    )
  );
$$;

revoke execute on function public.ticket_owner_for_school(uuid) from public, anon;
grant execute on function public.ticket_owner_for_school(uuid) to authenticated;

-- Hand a ticket to someone else. Auto-routing is a good default, not a
-- verdict: a ticket that lands on the wrong desk (a West school falling back
-- to the Academic Manager, a Central RM receiving something that belongs to
-- South) has to be movable without an admin.
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

  -- The current owner can hand it on; org-wide roles can move anything. A
  -- Regional Manager who is NOT the owner cannot reach into someone else's
  -- queue, even inside their own region.
  if not (
    v_ticket.assigned_agent_id = v_uid
    or v_role in ('operations_manager', 'cpo', 'academic_manager')
  ) then
    raise exception 'Only the assigned manager can reassign this ticket.';
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
    return v_ticket; -- idempotent no-op rather than a spurious log entry.
  end if;

  select full_name into v_old_name from public.profiles where id = v_ticket.assigned_agent_id;

  update public.tickets
     set assigned_agent_id = p_new_agent_id,
         updated_at = now()
   where id = p_ticket_id
   returning * into v_ticket;

  -- Logged as an internal note, so the thread carries its own history. The
  -- teacher never sees the handoff — it is not their business who inside YMU
  -- owns it, only that someone does.
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

revoke execute on function public.reassign_ticket(uuid, uuid, text) from public, anon;
grant execute on function public.reassign_ticket(uuid, uuid, text) to authenticated;

-- ===========================================================================
-- 6. RLS
-- ===========================================================================

alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;
alter table public.feedback_submissions enable row level security;

revoke all on table public.tickets from anon, authenticated;
revoke all on table public.ticket_messages from anon, authenticated;
revoke all on table public.feedback_submissions from anon, authenticated;

grant select on table public.tickets to authenticated;
grant select, insert on table public.ticket_messages to authenticated;
grant select on table public.feedback_submissions to authenticated;
grant all on table public.tickets to service_role;
grant all on table public.ticket_messages to service_role;
grant all on table public.feedback_submissions to service_role;

-- academic_manager reads everything, everywhere — that is the whole point of
-- the role (YMU 2026-08-12). It is deliberately not an assignee.
create policy tickets_select on public.tickets
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or assigned_agent_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
    or (
      public.current_app_role() = 'regional_manager'
      and region = public.current_app_region()
    )
  );

-- Internal notes are agent-only. A teacher reading the thread must not see
-- them, which is why this is not simply "can you see the parent ticket".
create policy ticket_messages_select on public.ticket_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_messages.ticket_id
        and (
          t.teacher_id = auth.uid()
          or t.assigned_agent_id = auth.uid()
          or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
          or (public.current_app_role() = 'regional_manager' and t.region = public.current_app_region())
        )
    )
    and (
      is_internal_note = false
      or public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo', 'academic_manager')
    )
  );

create policy ticket_messages_insert on public.ticket_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.tickets t
      where t.id = ticket_messages.ticket_id
        and (
          t.teacher_id = auth.uid()
          or t.assigned_agent_id = auth.uid()
          or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
          or (public.current_app_role() = 'regional_manager' and t.region = public.current_app_region())
        )
    )
    -- Only agents may write an internal note.
    and (
      is_internal_note = false
      or public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo', 'academic_manager')
    )
  );

create policy feedback_submissions_select on public.feedback_submissions
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
    or (
      public.current_app_role() = 'regional_manager'
      and exists (
        select 1 from public.schools s
        where s.id = feedback_submissions.school_id
          and s.region = public.current_app_region()
      )
    )
  );

-- No INSERT/UPDATE grant on tickets or feedback_submissions for authenticated:
-- every write goes through the SECURITY DEFINER RPC below, the same pattern
-- attendance_sessions has used since 0008.

-- ===========================================================================
-- 7. Submit: one transaction, feedback + ticket + the 24-hour gate
-- ===========================================================================

create or replace function public.submit_class_feedback(
  p_session_id uuid,
  p_engagement_level text,
  p_quarter_goals_on_track boolean,
  p_program_id uuid default null,
  p_program_name_raw text default null,
  p_primary_focus_pillar text default null,
  p_specific_topic_ids uuid[] default '{}',
  p_open_topic_note text default null,
  p_has_issue boolean default false,
  p_issue_category text default null,
  p_issue_subcategory text default null,
  p_issue_description text default null,
  p_priority_level text default 'Normal'
)
returns public.feedback_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions;
  v_row public.feedback_submissions;
  v_ticket_id uuid;
  v_owner uuid;
  v_region public.region;
  v_category text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit feedback.';
  end if;

  select * into v_session from public.attendance_sessions where id = p_session_id;
  if not found or v_session.teacher_id <> v_uid then
    raise exception 'That class could not be found.';
  end if;
  if v_session.feedback_settled_at is not null then
    raise exception 'You have already submitted feedback for this class.';
  end if;

  if p_engagement_level is null or p_engagement_level not in ('High', 'Solid', 'Low') then
    raise exception 'Please choose how students engaged today.';
  end if;
  if p_quarter_goals_on_track is null then
    raise exception 'Please answer whether you are on track with quarter goals.';
  end if;

  -- PRD 2.2: a flagged issue REQUIRES a category and >= 15 characters of
  -- detail. Enforced here as well as in the client, because the client is a
  -- convenience and this is the contract.
  if p_has_issue then
    if p_issue_category is null or btrim(p_issue_category) = '' then
      raise exception 'Please choose what kind of support you need.';
    end if;
    if p_issue_description is null or length(btrim(p_issue_description)) < 15 then
      raise exception 'Please describe the issue in at least 15 characters.';
    end if;
  end if;

  insert into public.feedback_submissions (
    session_id, teacher_id, school_id, event_id, program_id, program_name_raw,
    engagement_level, primary_focus_pillar, specific_topic_ids, open_topic_note,
    quarter_goals_on_track, has_issue
  ) values (
    p_session_id, v_uid, v_session.school_id, v_session.event_id, p_program_id,
    nullif(btrim(coalesce(p_program_name_raw, '')), ''),
    p_engagement_level,
    nullif(btrim(coalesce(p_primary_focus_pillar, '')), ''),
    coalesce(p_specific_topic_ids, '{}'),
    nullif(btrim(coalesce(p_open_topic_note, '')), ''),
    p_quarter_goals_on_track, coalesce(p_has_issue, false)
  )
  returning * into v_row;

  -- Discharge the 24-hour obligation, and close the class if it is still open
  -- (never later than its scheduled end, so no unscheduled hours appear).
  update public.attendance_sessions
     set feedback_settled_at = now(),
         clock_out_at = coalesce(clock_out_at, least(now(), coalesce(scheduled_end_at, now()))),
         clock_out_source = coalesce(clock_out_source, 'feedback')
   where id = p_session_id;

  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: feedback submitted in-app')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  -- Ticket, when either Section 3 or Section 4 asks for one. Same transaction
  -- as the submission: PRD Module B requires exactly one ticket per flagged
  -- submission, never zero and never a duplicate.
  if p_has_issue or p_quarter_goals_on_track = false then
    select region into v_region from public.schools where id = v_session.school_id;
    v_owner := public.ticket_owner_for_school(v_session.school_id);

    -- Falling behind with no separate issue is Academic by definition; an
    -- explicitly flagged issue carries whatever the teacher chose.
    v_category := case
      when p_has_issue then coalesce(nullif(btrim(coalesce(p_issue_category, '')), ''), 'Operational')
      else 'Academic'
    end;
    if v_category not in ('Operational', 'Academic') then
      v_category := 'Operational';
    end if;

    insert into public.tickets (
      teacher_id, school_id, event_id, session_id, region,
      category_type, issue_subcategory, priority_level, description, assigned_agent_id
    ) values (
      v_uid, v_session.school_id, v_session.event_id, p_session_id, v_region,
      v_category,
      nullif(btrim(coalesce(p_issue_subcategory, '')), ''),
      case when p_priority_level in ('Urgent', 'High', 'Normal') then p_priority_level else 'Normal' end,
      case
        when p_has_issue then btrim(p_issue_description)
        else 'Reported falling behind on quarter/concert goals via the daily feedback form.'
      end,
      v_owner
    )
    returning id into v_ticket_id;

    -- No RM for this region and no CPO either. Louder than failing silently:
    -- an unassigned ticket is invisible to every scoped inbox.
    if v_owner is null then
      insert into public.flags (type, session_id, event_id, teacher_id, school_id, details)
      values (
        'ticket_unassigned', p_session_id, v_session.event_id, v_uid, v_session.school_id,
        jsonb_build_object('ticket_id', v_ticket_id, 'region', v_region)
      );
    end if;

    -- Tell the owner. Reuses the enriched payload 0027 introduced, so the push
    -- names the teacher, the school and the phone rather than saying nothing.
    if v_owner is not null then
      insert into public.notification_queue (recipient_id, event_id, type, payload)
      values (
        v_owner, v_session.event_id, 'ticket_opened',
        public.manager_notification_payload(v_uid, v_session.school_id, v_session.event_id)
          || jsonb_build_object('ticket_id', v_ticket_id, 'category_type', v_category)
      );
    end if;
  end if;

  return v_row;
end;
$$;

revoke execute on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text, uuid[], text, boolean, text, text, text, text
) from public, anon;
grant execute on function public.submit_class_feedback(
  uuid, text, boolean, uuid, text, text, uuid[], text, boolean, text, text, text, text
) to authenticated;

-- The flags CHECK predates this escalation type. notification_queue needs no
-- equivalent — it constrains email_status but never type, and its
-- reminder-once partial unique index covers only the three reminder types, so
-- ticket_opened/ticket_assigned rows pass through untouched.
alter table public.flags drop constraint if exists flags_type_check;
alter table public.flags add constraint flags_type_check
  check (type in ('gps_out_of_fence', 'late_clock_in', 'feedback_stuck', 'ticket_unassigned'));
