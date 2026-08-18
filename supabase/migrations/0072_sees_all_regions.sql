-- ===========================================================================
-- 0072 — one definition of "sees everything"
-- ===========================================================================
--
-- Twenty-one policies and a dozen functions each named the global roles by
-- hand, as ('operations_manager','cpo') or ('operations_manager','cpo',
-- 'academic_manager'). Adding administrator to the app meant writing one word
-- in thirty-three places, and the next role would cost the same again. Worse,
-- the two spellings had drifted apart: academic_manager was global on tickets
-- and feedback but absent from attendance, flags, schedules and reports, so
-- "sees everything" already meant two different things depending on the table.
--
-- YMU settled it (2026-08-18): cpo, operations_manager, academic_manager and
-- administrator are the same account with four names. So the list moves into
-- current_sees_all_regions() and the policies ask that instead. Adding a fifth
-- role is now one line.
--
-- Purely additive. Nobody loses a row: every branch replaced here was a strict
-- subset of the new one. academic_manager and administrator GAIN the tables
-- they were missing, which is the point.
--
-- Note what is NOT collapsed: the ('regional_manager','operations_manager',
-- 'cpo') lists. Those are "any manager", not "sees everything", and folding
-- them in would have quietly dropped the Regional Manager. They become
-- `regional_manager or current_sees_all_regions()` instead.
-- ===========================================================================

create or replace function public.current_sees_all_regions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.archived_at is null
       and p.role in ('cpo', 'operations_manager', 'academic_manager', 'administrator')
  );
$$;

comment on function public.current_sees_all_regions() is
  'The four org-wide roles, in one place. Every policy and definer function that used to enumerate them calls this instead — adding a role is a one-line change here. Mirrored by GLOBAL_ROLES in lib/auth/roles.ts.';

revoke execute on function public.current_sees_all_regions() from public, anon;
grant execute on function public.current_sees_all_regions() to authenticated;

-- Team administration and the Operations Manager tier are now the same set:
-- four identical accounts means no reason for one to out-rank another.
create or replace function public.current_can_manage_team()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_sees_all_regions()
    -- Still the bridge for region3@ymu.org, still temporary. It is now safe to
    -- retire: administrator sees everything as of this migration, so that
    -- account can hold it without losing Central. What is NOT automatic is
    -- ticket routing — that account is currently the only Central RM, and
    -- ticket_owner_for_school() picks the RM by region. Retire this line in the
    -- change that hands Central to someone.
    or exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.archived_at is null and p.is_app_admin
    );
$$;

create or replace function public.current_can_assign_operations_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_sees_all_regions();
$$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- ALTER rather than drop-and-create: there is no window where the table sits
-- unprotected, and the policy's name, command and role stay put.

-- app_feedback keeps its is_app_admin branch. That flag IS this inbox
-- (migration 0024) — the one place it was always meant to decide something.
alter policy app_feedback_select_admins on public.app_feedback
  using (
    public.current_sees_all_regions()
    or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin
    )
  );

alter policy app_feedback_update_admins on public.app_feedback
  using (
    public.current_sees_all_regions()
    or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin
    )
  )
  with check (
    public.current_sees_all_regions()
    or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin
    )
  );

alter policy attendance_sessions_select on public.attendance_sessions
  using (
    teacher_id = auth.uid()
    or public.current_sees_all_regions()
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

alter policy calendar_events_select on public.calendar_events
  using (
    auth.uid() = any (teacher_ids)
    or public.current_sees_all_regions()
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

-- "Any manager", not "sees everything" — the Regional Manager stays named.
-- The afterschool manager is deliberately absent: resolve_calendar_issue()
-- maps a whole Google calendar onto a school and stays the RM's job (0070).
alter policy calendar_sync_issues_select on public.calendar_sync_issues
  using (
    public.current_app_role() = 'regional_manager'
    or public.current_sees_all_regions()
  );

alter policy calendar_sync_state_select on public.calendar_sync_state
  using (
    public.current_app_role() = 'regional_manager'
    or public.current_sees_all_regions()
  );

alter policy clock_in_attempts_select on public.clock_in_attempts
  using (
    teacher_id = auth.uid()
    or public.current_sees_all_regions()
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

alter policy feedback_submissions_select on public.feedback_submissions
  using (
    teacher_id = auth.uid()
    or public.current_sees_all_regions()
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

alter policy flags_select on public.flags
  using (
    public.current_sees_all_regions()
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

alter policy gps_checks_select on public.gps_checks
  using (
    teacher_id = auth.uid()
    or public.current_sees_all_regions()
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

alter policy notification_queue_select on public.notification_queue
  using (
    recipient_id = auth.uid()
    or public.current_sees_all_regions()
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

alter policy program_topics_write on public.program_topics
  using (public.current_sees_all_regions())
  with check (public.current_sees_all_regions());

alter policy programs_write on public.programs
  using (public.current_sees_all_regions())
  with check (public.current_sees_all_regions());

-- Reference data. The afterschool manager is added here and nowhere else in
-- this group: /reports gives her a school-year picker, and a picker with no
-- options is a broken page rather than a closed door.
alter policy school_years_select on public.school_years
  using (
    public.current_app_role() in ('regional_manager', 'afterschool_manager')
    or public.current_sees_all_regions()
  );

alter policy school_years_write on public.school_years
  using (public.current_sees_all_regions())
  with check (public.current_sees_all_regions());

alter policy schools_insert on public.schools
  with check (
    (
      public.current_app_role() = 'regional_manager'
      or public.current_sees_all_regions()
    )
    -- A Regional Manager may add a school, but not assign it a region.
    and (region is null or public.current_sees_all_regions())
  );

alter policy schools_select on public.schools
  using (
    public.current_sees_all_regions()
    or (
      public.current_app_role() = 'regional_manager'
      and (region is null or region = public.current_app_region())
    )
    or public.teacher_has_scheduled_school(id)
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.school_hosts_afterschool(id)
    )
  );

alter policy schools_update on public.schools
  using (
    public.current_app_role() = 'regional_manager'
    or public.current_sees_all_regions()
  )
  with check (
    public.current_app_role() = 'regional_manager'
    or public.current_sees_all_regions()
  );

alter policy tickets_select on public.tickets
  using (
    teacher_id = auth.uid()
    or assigned_agent_id = auth.uid()
    or public.current_sees_all_regions()
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

alter policy ticket_messages_select on public.ticket_messages
  using (
    exists (
      select 1 from public.tickets t
       where t.id = ticket_messages.ticket_id
         and (
           t.teacher_id = auth.uid()
           or t.assigned_agent_id = auth.uid()
           or public.current_sees_all_regions()
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
      or public.current_app_role() in ('regional_manager', 'afterschool_manager')
      or public.current_sees_all_regions()
    )
  );

alter policy ticket_messages_insert on public.ticket_messages
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.tickets t
       where t.id = ticket_messages.ticket_id
         and (
           t.teacher_id = auth.uid()
           or t.assigned_agent_id = auth.uid()
           or public.current_sees_all_regions()
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
      or public.current_app_role() in ('regional_manager', 'afterschool_manager')
      or public.current_sees_all_regions()
    )
  );

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- Patched in place from the live definitions rather than restated. Between
-- them these are well over a thousand lines, and a restatement is a second
-- copy that drifts. Every substitution raises if its target is missing, so a
-- guard that has been reworded fails this migration loudly instead of silently
-- leaving a role locked out.

do $do$
declare
  v_patch record;
  v_def text;
begin
  for v_patch in
    select * from (values
      ('can_read_profile',
       $q$public.current_app_role() in ('operations_manager', 'cpo', 'academic_manager')$q$,
       $q$public.current_sees_all_regions()$q$),
      ('report_teacher_roster',
       $q$public.current_app_role() in ('operations_manager', 'cpo')$q$,
       $q$public.current_sees_all_regions()$q$),
      ('teacher_directory',
       $q$public.current_app_role() in ('operations_manager', 'cpo')$q$,
       $q$public.current_sees_all_regions()$q$),
      ('resolve_flag',
       $q$v_role not in ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager')$q$,
       $q$not (v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions())$q$),
      ('admin_edit_attendance',
       $q$v_role not in ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager')$q$,
       $q$not (v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions())$q$),
      ('admin_create_attendance',
       $q$v_role not in ('regional_manager', 'operations_manager', 'cpo', 'afterschool_manager')$q$,
       $q$not (v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions())$q$),
      ('set_ticket_status',
       $q$v_role in ('operations_manager', 'cpo', 'academic_manager')$q$,
       $q$public.current_sees_all_regions()$q$),
      ('reassign_ticket',
       $q$v_role in ('operations_manager', 'cpo', 'academic_manager')$q$,
       $q$public.current_sees_all_regions()$q$),
      ('assign_event_school',
       $q$v_role in ('regional_manager', 'afterschool_manager', 'operations_manager', 'cpo')$q$,
       $q$v_role in ('regional_manager', 'afterschool_manager') or public.current_sees_all_regions()$q$),
      ('resolve_calendar_issue',
       $q$v_role in ('regional_manager', 'operations_manager', 'cpo')$q$,
       $q$v_role = 'regional_manager' or public.current_sees_all_regions()$q$),
      ('find_substitutes',
       $q$array['regional_manager', 'afterschool_manager', 'academic_manager', 'operations_manager', 'cpo']::public.app_role[]$q$,
       $q$array['regional_manager', 'afterschool_manager', 'academic_manager', 'operations_manager', 'administrator', 'cpo']::public.app_role[]$q$)
    ) as t(fn, old_text, new_text)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_patch.fn;

    if v_def is null then
      raise exception 'function %() not found', v_patch.fn;
    end if;

    if position(v_patch.old_text in v_def) = 0 then
      if position(v_patch.new_text in v_def) > 0 then
        continue; -- already applied
      end if;
      raise exception 'the guard in %() has changed - re-do this patch by hand', v_patch.fn;
    end if;

    execute replace(v_def, v_patch.old_text, v_patch.new_text);
  end loop;
end
$do$;

-- ticket_owner_for_school() is deliberately untouched. Its role list is an
-- assignment LADDER (region's RM, then the Academic Manager, then CPO/OM), not
-- a visibility check. Collapsing tiers that are meant to be ordered would
-- change who ends up holding a ticket, which is not what this migration is for.
