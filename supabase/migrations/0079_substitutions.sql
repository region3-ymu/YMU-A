-- ===========================================================================
-- 0079 — a substitution becomes a record instead of a sentence
-- ===========================================================================
--
-- /substitutes has been a read-only finder since 0060: it ranks who is free
-- during the class and hands the manager a mailto: and a tel: link. What
-- happens next happens outside the app, and the app never learns it happened.
--
-- So "who actually taught this class, and why wasn't the regular teacher
-- there" is only answerable by reading prose. The real notes on the Flags tab:
--
--   "No change in payroll adjustment. Confirmed DeAnthony as the substitute
--    for this class."
--   "Substitute for Riley Fuentes at North County for 8/18/2026"
--   "Substitute Assigned"
--
-- Three managers, three formats, one of them naming a person who cannot be
-- joined to anything.
--
-- ── What this does NOT do yet ────────────────────────────────────────────
--
-- It does not change the Google Calendar event. DECISIONS.md:101 is right that
-- Google has no primary/substitute distinction — the regular teacher and the
-- substitute are simply two matched attendees — and the calendar is where
-- teacher_ids comes from. But the service account cannot write it today:
-- src/lib/google/calendar.ts requests calendar.readonly, and it would also
-- need "Make changes to events" on all ~109 school calendars, which every
-- calendar's owner has to grant. Neither is a code change.
--
-- calendar_write_status carries that reality on the row rather than hiding it:
-- 'manual' means "recorded here, someone still has to edit Google", which is
-- exactly today's process plus a record of it. 0081 adds the write path behind
-- a flag for the day the access exists.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Why a teacher was not there, in SQL, once
-- ---------------------------------------------------------------------------
-- Shared by substitutions.reason and by the absence_reason on a flag
-- resolution in 0080. Those are the same question asked from two screens, and
-- two lists would have drifted the way "forgot" drifted into six spellings.
--
-- Same shape and the same reasoning as flag_reason_label() in 0076.

create or replace function public.absence_reason_label(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'sick'             then 'Sick'
    when 'family_emergency' then 'Family emergency'
    when 'personal'         then 'Personal'
    when 'second_job'       then 'Conflict with another job'
    when 'transport'        then 'Transport / car trouble'
    when 'training'         then 'Training or a YMU commitment'
    when 'school_request'   then 'The school asked for a change'
    when 'no_reason_given'  then 'No reason given'
    when 'other'            then 'Other'
  end;
$$;

comment on function public.absence_reason_label(text) is
  'The label for a teacher-absence reason code, or null if the code is not one of the nine. Twin of src/lib/attendance/absence-reasons.ts. Shared by substitutions.reason and the absence_reason on a flag resolution.';

grant execute on function public.absence_reason_label(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------
-- Two statuses, not four. 'proposed' and 'declined' were both drafted and cut:
-- there is no substitute-facing screen for anyone to accept or decline on, so
-- a proposed row would only ever be a confirmed one a manager had not clicked
-- twice, and modelling a workflow that does not exist is how a status column
-- comes to mean nothing. Add them when there is something that sets them.

create table if not exists public.substitutions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.calendar_events (id) on delete cascade,
  school_id uuid references public.schools (id) on delete set null,
  -- Which teacher is being covered. Not derivable from the event: a co-taught
  -- class has two matched teachers and only one of them is away.
  absent_teacher_id uuid not null references public.profiles (id) on delete cascade,
  substitute_teacher_id uuid not null references public.profiles (id) on delete restrict,
  reason text not null,
  reason_notes text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz not null default now(),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  -- 'manual' is the honest default while the service account is read-only: the
  -- substitution is recorded, and a person still has to edit the Google event.
  calendar_write_status text not null default 'manual'
    check (calendar_write_status in ('manual', 'pending', 'written', 'failed')),
  calendar_write_error text,
  calendar_written_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Duplicated from absence_reason_label() on purpose. A CHECK that calls a
  -- function ties the table's validity to dump/restore ordering, and this is
  -- only the second line of defence — confirm_substitution() validates
  -- against the function itself, and there is no write policy, so nothing
  -- reaches this table any other way.
  constraint substitutions_reason_known check (reason in (
    'sick', 'family_emergency', 'personal', 'second_job', 'transport',
    'training', 'school_request', 'no_reason_given', 'other'
  )),
  -- Covering yourself is not a substitution, it is a typo.
  constraint substitutions_not_self
    check (absent_teacher_id <> substitute_teacher_id)
);

-- One live substitution per teacher per class. A cancelled row does not block
-- a replacement, which is what makes "actually, it's Gerdy now" possible
-- without deleting the history of asking DeAnthony first.
create unique index if not exists substitutions_one_live_per_teacher_event
  on public.substitutions (event_id, absent_teacher_id)
  where status = 'confirmed';

create index if not exists substitutions_school_idx on public.substitutions (school_id);
create index if not exists substitutions_substitute_idx on public.substitutions (substitute_teacher_id);

comment on table public.substitutions is
  'Who covered a class the assigned teacher missed, and why they missed it. The app is the record; the Google Calendar event is still edited by hand until the service account has write access (see calendar_write_status).';
comment on column public.substitutions.calendar_write_status is
  'manual = recorded here, the Google event still needs editing by a person. pending/written/failed are used once GOOGLE_CALENDAR_WRITE_ENABLED is on.';

alter table public.substitutions enable row level security;

create trigger substitutions_touch
  before update on public.substitutions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Who can see one
-- ---------------------------------------------------------------------------
-- Mirrors flags_select: managers only, region-scoped for a Regional Manager,
-- afterschool classes to the afterschool manager. Plus the two teachers named
-- on the row — unlike a flag, a substitution is not an escalation about
-- somebody, it is a fact they both need. A teacher covering a class at another
-- school has to be able to see that they are on it.
create policy substitutions_select on public.substitutions
  for select to authenticated
  using (
    absent_teacher_id = auth.uid()
    or substitute_teacher_id = auth.uid()
    or public.current_sees_all_regions()
    or (
      public.current_app_role() = 'regional_manager'
      and not public.afterschool_owned_event(event_id)
      and exists (
        select 1 from public.schools s
         where s.id = substitutions.school_id
           and (s.region is null or s.region = public.current_app_region())
      )
    )
    or (
      public.current_app_role() = 'afterschool_manager'
      and public.afterschool_owned_event(event_id)
    )
  );

-- No insert/update/delete policy at all. Every write goes through
-- confirm_substitution() or cancel_substitution() below, which are
-- SECURITY DEFINER and re-check the caller — the same arrangement flags uses.
-- A table with no write policy is the clearest possible statement that the
-- functions are the only door.

-- ---------------------------------------------------------------------------
-- 4. Confirming one
-- ---------------------------------------------------------------------------
-- The authorization guard is find_substitutes()'s, verbatim and for the same
-- reason: choosing a substitute reaches past a region (YMU 2026-08-14 — a
-- substitute from the next region over beats no substitute), so the region
-- check that applies is on the CLASS, not on the substitute.

create or replace function public.confirm_substitution(
  p_event_id       uuid,
  p_absent_teacher uuid,
  p_substitute     uuid,
  p_reason         text,
  p_reason_notes   text default null
)
returns public.substitutions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_role  public.app_role := public.current_app_role();
  v_event public.calendar_events;
  v_row   public.substitutions;
  v_school_region public.region;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if (v_role = any (array[
        'regional_manager', 'afterschool_manager', 'academic_manager',
        'operations_manager', 'administrator', 'cpo'
      ]::public.app_role[])) is not true then
    raise exception 'Confirming a substitute requires a manager role.';
  end if;
  if public.absence_reason_label(p_reason) is null then
    raise exception 'Choose a reason the teacher is away. "%" is not one of them.', coalesce(p_reason, '');
  end if;
  if p_reason = 'other' and nullif(btrim(coalesce(p_reason_notes, '')), '') is null then
    raise exception 'Choosing "Other" means writing why they are away.';
  end if;

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'Class not found.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'That class is cancelled — it does not need covering.';
  end if;
  if not (p_absent_teacher = any(coalesce(v_event.teacher_ids, '{}'::uuid[]))) then
    raise exception 'That teacher is not assigned to this class.';
  end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = p_substitute and p.role = 'teacher' and p.archived_at is null
  ) then
    raise exception 'The substitute must be an active teacher.';
  end if;

  -- Region and afterschool scoping, on the class.
  if v_role = 'regional_manager' then
    if public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_event.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only arrange cover for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager'
    and not public.afterschool_owned(v_event.is_afterschool, v_event.start_at) then
    raise exception 'You can only arrange cover on afterschool classes.';
  end if;

  -- The availability check that find_substitutes() applies, re-applied here.
  -- Minutes can pass between reading that list and clicking Confirm, and the
  -- one thing that must not happen is a substitute double-booked into two
  -- classes at once.
  if exists (
    select 1 from public.calendar_events e
     where p_substitute = any(e.teacher_ids)
       and e.status <> 'cancelled'
       and e.start_at < v_event.end_at
       and e.end_at   > v_event.start_at
  ) then
    raise exception 'That teacher is already teaching during this class.';
  end if;

  -- Supersede rather than reject. A manager changing their mind about who
  -- covers a class should not have to find and cancel the old row first, and
  -- the old row is worth keeping.
  update public.substitutions
     set status = 'cancelled',
         cancelled_by = v_uid,
         cancelled_at = now(),
         cancel_reason = 'Superseded by a later substitution'
   where event_id = p_event_id
     and absent_teacher_id = p_absent_teacher
     and status = 'confirmed';

  insert into public.substitutions (
    event_id, school_id, absent_teacher_id, substitute_teacher_id,
    reason, reason_notes, status, confirmed_by, created_by
  )
  values (
    p_event_id, v_event.school_id, p_absent_teacher, p_substitute,
    p_reason, nullif(btrim(coalesce(p_reason_notes, '')), ''),
    'confirmed', v_uid, v_uid
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.confirm_substitution(uuid, uuid, uuid, text, text) is
  'Records that one teacher is covering another''s class, and why the assigned teacher is away. Re-checks the substitute is still free — find_substitutes() ranked them minutes earlier. Supersedes any existing confirmed substitution for the same (class, absent teacher).';

revoke execute on function public.confirm_substitution(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.confirm_substitution(uuid, uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Cancelling one
-- ---------------------------------------------------------------------------

create or replace function public.cancel_substitution(
  p_substitution_id uuid,
  p_reason          text
)
returns public.substitutions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_row  public.substitutions;
  v_school_region public.region;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  if (v_role = any (array[
        'regional_manager', 'afterschool_manager', 'academic_manager',
        'operations_manager', 'administrator', 'cpo'
      ]::public.app_role[])) is not true then
    raise exception 'Cancelling a substitution requires a manager role.';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to cancel a substitution.';
  end if;

  select * into v_row from public.substitutions where id = p_substitution_id;
  if not found then
    raise exception 'Substitution not found.';
  end if;
  if v_row.status <> 'confirmed' then
    raise exception 'That substitution is already cancelled.';
  end if;

  if v_role = 'regional_manager' then
    if public.afterschool_owned_event(v_row.event_id) then
      raise exception 'Afterschool classes are handled by the afterschool manager.';
    end if;
    select s.region into v_school_region from public.schools s where s.id = v_row.school_id;
    if v_school_region is distinct from public.current_app_region() then
      raise exception 'You can only change cover for schools in your own region.';
    end if;
  elsif v_role = 'afterschool_manager' and not public.afterschool_owned_event(v_row.event_id) then
    raise exception 'You can only change cover on afterschool classes.';
  end if;

  update public.substitutions
     set status = 'cancelled',
         cancelled_by = v_uid,
         cancelled_at = now(),
         cancel_reason = btrim(p_reason)
   where id = p_substitution_id
   returning * into v_row;

  return v_row;
end;
$$;

comment on function public.cancel_substitution(uuid, text) is
  'Marks a substitution cancelled with a reason. Never deletes — the fact that cover was arranged and then withdrawn is the thing worth knowing.';

revoke execute on function public.cancel_substitution(uuid, text) from public, anon;
grant execute on function public.cancel_substitution(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The class a manager might need to cover, with its cover attached
-- ---------------------------------------------------------------------------
-- /substitutes builds its class list from calendar_events under RLS. This
-- returns the substitutions already recorded against those classes so the
-- screen can show "already covered" instead of offering the same class again.

create or replace function public.recent_substitutions(p_days integer default 30)
returns table (
  id uuid,
  event_id uuid,
  class_title text,
  class_start_at timestamptz,
  school_name text,
  region text,
  absent_teacher_id uuid,
  absent_teacher text,
  substitute_teacher_id uuid,
  substitute_teacher text,
  substitute_email text,
  reason text,
  reason_notes text,
  status text,
  confirmed_by text,
  confirmed_at timestamptz,
  cancel_reason text,
  calendar_write_status text
)
language sql
stable
set search_path = ''
as $$
  select
    sub.id,
    sub.event_id,
    ce.summary,
    ce.start_at,
    s.name,
    s.region::text,
    sub.absent_teacher_id,
    absent.full_name,
    sub.substitute_teacher_id,
    stand_in.full_name,
    u.email::text,
    public.absence_reason_label(sub.reason),
    sub.reason_notes,
    sub.status,
    confirmer.full_name,
    sub.confirmed_at,
    sub.cancel_reason,
    sub.calendar_write_status
  from public.substitutions sub
  left join public.calendar_events ce on ce.id = sub.event_id
  left join public.schools s on s.id = sub.school_id
  left join public.profiles absent on absent.id = sub.absent_teacher_id
  left join public.profiles stand_in on stand_in.id = sub.substitute_teacher_id
  left join auth.users u on u.id = sub.substitute_teacher_id
  left join public.profiles confirmer on confirmer.id = sub.confirmed_by
  -- Windowed on the CLASS date, not confirmed_at: cover arranged three weeks
  -- ahead is the row a manager most wants to see, and it would fall off a
  -- window measured from when it was booked.
  where ce.start_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  order by ce.start_at desc;
$$;

-- NOT security definer, deliberately, unlike its neighbours in this file.
-- substitutions_select and calendar_events_select already say who may read
-- what, and a definer function here would quietly widen that — a Regional
-- Manager would see every region's cover. The writes need definer because
-- they reach across regions; the read does not.
comment on function public.recent_substitutions(integer) is
  'Substitutions for classes in the last p_days and everything ahead, newest class first. Runs under the caller''s RLS on purpose.';

revoke execute on function public.recent_substitutions(integer) from public, anon;
grant execute on function public.recent_substitutions(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The spreadsheet tab
-- ---------------------------------------------------------------------------

create or replace function public.substitutions_for_sheet()
returns table (
  class_date date,
  class_time text,
  class_title text,
  school_name text,
  region text,
  absent_teacher text,
  absent_teacher_email text,
  covered_by text,
  covered_by_email text,
  reason text,
  reason_notes text,
  status text,
  confirmed_by text,
  confirmed_at timestamptz,
  cancelled_by text,
  cancelled_at timestamptz,
  cancel_reason text,
  google_calendar text,
  substitution_id uuid,
  event_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    ce.summary,
    s.name,
    s.region::text,
    absent.full_name,
    absent_user.email::text,
    stand_in.full_name,
    stand_in_user.email::text,
    public.absence_reason_label(sub.reason),
    sub.reason_notes,
    sub.status,
    confirmer.full_name,
    sub.confirmed_at,
    canceller.full_name,
    sub.cancelled_at,
    sub.cancel_reason,
    -- Whether the Google event actually says this yet. 'manual' means it does
    -- not, and someone has to go and change the attendee by hand.
    case sub.calendar_write_status
      when 'manual'  then 'Needs editing by hand'
      when 'pending' then 'Queued'
      when 'written' then 'Updated'
      when 'failed'  then 'Failed — ' || coalesce(sub.calendar_write_error, 'no detail')
    end,
    sub.id,
    sub.event_id
  from public.substitutions sub
  left join public.calendar_events ce on ce.id = sub.event_id
  left join public.schools s on s.id = sub.school_id
  left join public.profiles absent on absent.id = sub.absent_teacher_id
  left join auth.users absent_user on absent_user.id = sub.absent_teacher_id
  left join public.profiles stand_in on stand_in.id = sub.substitute_teacher_id
  left join auth.users stand_in_user on stand_in_user.id = sub.substitute_teacher_id
  left join public.profiles confirmer on confirmer.id = sub.confirmed_by
  left join public.profiles canceller on canceller.id = sub.cancelled_by
  order by ce.start_at desc;
$$;

comment on function public.substitutions_for_sheet() is
  'Every substitution, confirmed and cancelled, with why the assigned teacher was away and whether the Google event has caught up.';

revoke execute on function public.substitutions_for_sheet() from public, anon, authenticated;
grant execute on function public.substitutions_for_sheet() to service_role;

-- ---------------------------------------------------------------------------
-- 8. Recording what Google did with it
-- ---------------------------------------------------------------------------
-- service_role only, because the caller is the server after it has spoken to
-- Google — not a manager, and not something a browser should be able to claim.
-- Marking a row 'written' when the calendar never changed is the one lie this
-- table could tell that matters: teacher_ids comes from the Google event, so a
-- substitute who is not on it cannot clock in, and a green chip saying
-- otherwise would send everyone looking in the wrong place.

create or replace function public.mark_substitution_calendar_write(
  p_substitution_id uuid,
  p_status          text,
  p_error           text default null
)
returns public.substitutions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.substitutions;
begin
  if p_status not in ('manual', 'pending', 'written', 'failed') then
    raise exception 'Unknown calendar write status: %', p_status;
  end if;

  update public.substitutions
     set calendar_write_status = p_status,
         calendar_write_error  = case when p_status = 'failed' then p_error end,
         calendar_written_at   = case when p_status = 'written' then now() end
   where id = p_substitution_id
   returning * into v_row;

  if not found then
    raise exception 'Substitution not found.';
  end if;

  return v_row;
end;
$$;

comment on function public.mark_substitution_calendar_write(uuid, text, text) is
  'Records the outcome of trying to update the Google Calendar event for a substitution. service_role only — the server calls this after Google answers.';

revoke execute on function public.mark_substitution_calendar_write(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_substitution_calendar_write(uuid, text, text) to service_role;
