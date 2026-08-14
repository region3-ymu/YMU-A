-- Let a manager dismiss a calendar for good.
--
-- schedule@ymu.org is the owning account's own mailbox calendar. It is not a
-- school, it has never produced a single event, and it has sat at the top of
-- the Schedules page since discovery asking a manager which school it belongs
-- to. It was dismissed once already (NEXT_STEPS.md) and came straight back.
--
-- Why it came back: syncAllCalendars upserts every unmatched calendar on every
-- run with `resolved_at: null` written explicitly. So "Not a school calendar"
-- set resolved_at, and the next sync — five minutes later — cleared it again.
-- The button never had a chance; nothing about it was wrong except that the
-- state it wrote was not one the sync respected.
--
-- resolved_at answers "has someone dealt with this?", which the sync is
-- entitled to re-ask when it rediscovers a calendar. ignored_at answers "is
-- this a school at all?", which it is not — so it gets its own column rather
-- than overloading the first, and the sync skips those calendars the same way
-- it skips ones already pinned to a school.

alter table public.calendar_sync_issues
  add column if not exists ignored_at timestamptz;

comment on column public.calendar_sync_issues.ignored_at is
  'Set when a manager says this calendar is not a school at all (an ops mailbox, a personal calendar). Unlike resolved_at, calendar-sync never clears it and stops re-flagging the calendar entirely. Null for everything awaiting a decision.';

create or replace function public.resolve_calendar_issue(
  p_calendar_id text,
  p_school_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := public.current_app_role();
  v_school_region public.region;
begin
  if coalesce(
    v_role in ('regional_manager', 'operations_manager', 'cpo'),
    false
  ) is false then
    raise exception 'only managers can resolve a calendar sync issue';
  end if;

  if p_school_id is not null then
    select region into strict v_school_region
    from public.schools where id = p_school_id;

    if v_role = 'regional_manager'
       and v_school_region is not null
       and v_school_region is distinct from public.current_app_region()
    then
      raise exception 'regional managers can only assign schools in their own region';
    end if;

    begin
      update public.schools
         set google_calendar_id = p_calendar_id,
             calendar_match_source = 'manual',
             calendar_match_score = null,
             calendar_matched_at = now()
       where id = p_school_id;
    exception when unique_violation then
      raise exception 'that calendar is already linked to a different school';
    end;
  end if;

  update public.calendar_sync_issues
     set resolved_at = now(),
         resolved_by = auth.uid(),
         -- No school means "this is not a school". That is a permanent fact
         -- about the calendar, so it has to survive the next sync.
         ignored_at = case
           when p_school_id is null then coalesce(ignored_at, now())
           else ignored_at
         end
   where calendar_id = p_calendar_id
     and resolved_at is null;
end;
$$;

comment on function public.resolve_calendar_issue(text, uuid) is
  'Resolves an unmatched-calendar issue. With a school, pins the calendar to it. Without one, marks the calendar permanently ignored — calendar-sync skips ignored calendars instead of re-flagging them every five minutes.';

revoke execute on function public.resolve_calendar_issue(text, uuid) from public, anon;
grant execute on function public.resolve_calendar_issue(text, uuid) to authenticated;

-- schedule@ymu.org itself. It is the account's own calendar, has zero events,
-- and the sync would otherwise re-raise it within five minutes of this
-- migration landing.
update public.calendar_sync_issues
   set resolved_at = coalesce(resolved_at, now()),
       ignored_at = coalesce(ignored_at, now())
 where calendar_id = 'schedule@ymu.org';
