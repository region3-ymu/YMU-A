-- ===========================================================================
-- 0064 — afterschool leaves the Regional Managers, and lands on one desk
-- ===========================================================================
--
-- Eleven policies scoped reads by region. Each one grows the same two clauses:
-- the regional_manager branch stops matching afterschool classes, and an
-- afterschool_manager branch matches them in every region.
--
-- The teacher branches are untouched, and that is deliberate: a teacher who
-- runs an afterschool class still has to clock into it and still owes feedback
-- on it, so `teacher_id = auth.uid()` has to keep winning first.
--
-- Scoped to the CURRENT SCHOOL YEAR (YMU 2026-08-18: "en esta app solo me
-- interesa la info de este año escolar. Todo a partir de ahora en adelante").
-- The 2025-26 afterschool history — roughly 1,500 events with their attendance,
-- feedback and tickets — stays where it already was, so no Regional Manager's
-- past reports change under them. That window lives here rather than in
-- calendar_events.is_afterschool because it moves every August; the column
-- records what a class IS, these policies decide whose it is right now.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. One rule, two entry points
-- ---------------------------------------------------------------------------
-- Two functions rather than one so nothing has to choose between a wasted
-- subquery and a duplicated rule: calendar_events has the columns in hand and
-- passes them, everything else has only an id and looks them up. The window
-- itself is written once, in afterschool_owned().

create or replace function public.afterschool_owned(
  p_is_afterschool boolean,
  p_start_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_is_afterschool, false)
     and p_start_at is not null
     and p_start_at >= public.current_school_year_start();
$$;

comment on function public.afterschool_owned(boolean, timestamptz) is
  'True when a class is the afterschool manager''s: classified afterschool AND inside the school year now in progress. The single definition of that window.';

create or replace function public.afterschool_owned_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.calendar_events e
     where e.id = p_event_id
       and public.afterschool_owned(e.is_afterschool, e.start_at)
  );
$$;

comment on function public.afterschool_owned_event(uuid) is
  'afterschool_owned() for a row that carries only an event_id. Null event_id is false — an unlinked row belongs to whoever owns it by region.';

create or replace function public.afterschool_owned_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.attendance_sessions a
     where a.id = p_session_id
       and public.afterschool_owned_event(a.event_id)
  );
$$;

comment on function public.afterschool_owned_session(uuid) is
  'afterschool_owned() for gps_checks, which reaches an event only through its session.';

revoke execute on function public.afterschool_owned(boolean, timestamptz) from public, anon;
revoke execute on function public.afterschool_owned_event(uuid) from public, anon;
revoke execute on function public.afterschool_owned_session(uuid) from public, anon;
grant execute on function public.afterschool_owned(boolean, timestamptz) to authenticated;
grant execute on function public.afterschool_owned_event(uuid) to authenticated;
grant execute on function public.afterschool_owned_session(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. calendar_events
-- ---------------------------------------------------------------------------

drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events
  for select to authenticated
  using (
    auth.uid() = any (teacher_ids)
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned(is_afterschool, start_at)
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
           where s.id = calendar_events.school_id
             and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned(is_afterschool, start_at)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. attendance_sessions
-- ---------------------------------------------------------------------------

drop policy if exists attendance_sessions_select on public.attendance_sessions;
create policy attendance_sessions_select on public.attendance_sessions
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_event(event_id)
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
           where s.id = attendance_sessions.school_id
             and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 4. clock_in_attempts
-- ---------------------------------------------------------------------------
-- Note this one has no `s.region is null` escape, unlike its neighbours.
-- Preserved as-is; widening it is not this migration's business.

drop policy if exists clock_in_attempts_select on public.clock_in_attempts;
create policy clock_in_attempts_select on public.clock_in_attempts
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_event(event_id)
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
           where s.id = clock_in_attempts.school_id
             and s.region = public.current_app_region()
        )
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. feedback_submissions
-- ---------------------------------------------------------------------------

drop policy if exists feedback_submissions_select on public.feedback_submissions;
create policy feedback_submissions_select on public.feedback_submissions
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_event(event_id)
      and exists (
        select 1 from public.schools s
         where s.id = feedback_submissions.school_id
           and s.region = public.current_app_region()
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 6. flags
-- ---------------------------------------------------------------------------

drop policy if exists flags_select on public.flags;
create policy flags_select on public.flags
  for select to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_event(event_id)
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
           where s.id = flags.school_id
             and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 7. gps_checks
-- ---------------------------------------------------------------------------

drop policy if exists gps_checks_select on public.gps_checks;
create policy gps_checks_select on public.gps_checks
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_session(session_id)
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
           where s.id = gps_checks.school_id
             and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_session(session_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 8. notification_queue
-- ---------------------------------------------------------------------------
-- The RM's scope here reads school_id out of the payload, not a column. Left
-- alone; the afterschool split rides on event_id, which is a real column.

drop policy if exists notification_queue_select on public.notification_queue;
create policy notification_queue_select on public.notification_queue
  for select to authenticated
  using (
    recipient_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_event(event_id)
      and exists (
        select 1 from public.schools s
         where s.id::text = notification_queue.payload ->> 'school_id'
           and (s.region is null or s.region = public.current_app_region())
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 9. schools
-- ---------------------------------------------------------------------------
-- The Regional Manager keeps every school in their region, afterschool or not.
-- Little River runs regular classes AND afterschool out of the same building;
-- taking the school away would break the region's whole page to fix nothing.
-- She gets the schools that actually host an afterschool class this year —
-- four today — rather than the blanket every-school read ops/cpo have.
--
-- The inline `exists` on calendar_events below is WRONG and 0066 replaces it
-- with a SECURITY DEFINER helper: reading calendar_events from here fires
-- calendar_events_select, which reads schools, which fires this policy again.
-- Left as it was applied so the migration history matches what production ran.

drop policy if exists schools_select on public.schools;
create policy schools_select on public.schools
  for select to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (region is null or region = public.current_app_region())
    )
    or public.teacher_has_scheduled_school(id)
    or (
      public.current_app_role() = 'afterschool_manager'
      and exists (
        select 1 from public.calendar_events e
         where e.school_id = schools.id
           and public.afterschool_owned(e.is_afterschool, e.start_at)
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 10. tickets
-- ---------------------------------------------------------------------------
-- assigned_agent_id = auth.uid() stays ahead of the region split, so an
-- afterschool ticket that is still ASSIGNED to a Regional Manager remains
-- visible to them however this policy is written. That is why 0065 changes who
-- afterschool tickets get assigned to — the policy alone does not finish the
-- job YMU asked for.

drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or assigned_agent_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
    or (
      public.current_app_role() = 'regional_manager'
      and region = public.current_app_region()
      and not public.afterschool_owned_event(event_id)
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 11. ticket_messages (select + insert)
-- ---------------------------------------------------------------------------
-- Both carry the same embedded copy of the ticket visibility rule, and both
-- have to grow the same two branches or she can read a thread she cannot reply
-- to. The internal-note clause gains afterschool_manager for the same reason:
-- she is a manager, and an inbox where she cannot leave an internal note is
-- not an inbox.

drop policy if exists ticket_messages_select on public.ticket_messages;
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
           or (
             public.current_app_role() = 'regional_manager'
             and t.region = public.current_app_region()
             and not public.afterschool_owned_event(t.event_id)
           )
           or (
             public.current_app_role() = 'afterschool_manager'
             and public.afterschool_owned_event(t.event_id)
           )
         )
    )
    and (
      is_internal_note = false
      or public.current_app_role() in (
        'regional_manager', 'operations_manager', 'cpo', 'academic_manager', 'afterschool_manager'
      )
    )
  );

drop policy if exists ticket_messages_insert on public.ticket_messages;
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
           or (
             public.current_app_role() = 'regional_manager'
             and t.region = public.current_app_region()
             and not public.afterschool_owned_event(t.event_id)
           )
           or (
             public.current_app_role() = 'afterschool_manager'
             and public.afterschool_owned_event(t.event_id)
           )
         )
    )
    and (
      is_internal_note = false
      or public.current_app_role() in (
        'regional_manager', 'operations_manager', 'cpo', 'academic_manager', 'afterschool_manager'
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 12. can_read_profile — otherwise every name on her pages reads "Unknown"
-- ---------------------------------------------------------------------------
-- Only the afterschool_manager branch is new; the rest is 0033/0041 verbatim.
-- She sees other managers (so assignee pickers and ticket threads render) and
-- the teachers who actually teach an afterschool class this year. Note she is
-- NOT given the region-based branches — she has no region, and giving her one
-- by accident is exactly the failure mode a nullable region invites.

create or replace function public.can_read_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_profile_id = (select auth.uid())
    or public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')
    or (
      public.current_app_role() = 'regional_manager'
      and (
        exists (
          select 1 from public.profiles p
           where p.id = p_profile_id and p.role <> 'teacher'
        )
        or exists (
          select 1 from public.profiles p
           where p.id = p_profile_id
             and p.region is not null
             and p.region = public.current_app_region()
        )
        or exists (
          select 1
            from public.calendar_events ce
            join public.schools s on s.id = ce.school_id
           where ce.teacher_ids @> array[p_profile_id]
             and s.region = public.current_app_region()
             and coalesce(ce.end_at, ce.start_at) >= now() - interval '1 day'
        )
        or exists (
          select 1 from public.attendance_sessions a
            join public.schools s on s.id = a.school_id
           where a.teacher_id = p_profile_id
             and s.region = public.current_app_region()
        )
        or exists (
          select 1 from public.tickets t
           where t.teacher_id = p_profile_id
             and (
               t.region = public.current_app_region()
               or t.assigned_agent_id = (select auth.uid())
             )
        )
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and (
        exists (
          select 1 from public.profiles p
           where p.id = p_profile_id and p.role <> 'teacher'
        )
        or exists (
          select 1 from public.calendar_events ce
           where ce.teacher_ids @> array[p_profile_id]
             and public.afterschool_owned(ce.is_afterschool, ce.start_at)
        )
        or exists (
          select 1 from public.attendance_sessions a
           where a.teacher_id = p_profile_id
             and public.afterschool_owned_event(a.event_id)
        )
      )
    );
$$;
