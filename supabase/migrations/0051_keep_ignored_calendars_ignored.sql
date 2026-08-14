-- Stop the sync from un-ignoring a calendar a manager has dismissed.
--
-- 0050 added ignored_at and taught calendar-sync to skip those calendars. This
-- is the same rule enforced in the database, and it is the authoritative half:
--
--   * The Edge Function only takes effect once it is deployed, and the repo has
--     already drifted ahead of production once (the 7-day cancellation horizon
--     from 2447c9a is committed but not live). A dismissal that silently stops
--     working the next time someone forgets to deploy is exactly the bug we are
--     fixing, so it must not depend on a deploy.
--   * syncAllCalendars upserts with `resolved_at: null` written explicitly.
--     That is a blunt overwrite of a decision a human made. The table is
--     entitled to refuse it.
--
-- The trigger deliberately does not block the upsert — the sync legitimately
-- refreshes calendar_summary and candidates, and failing the write would break
-- the whole run over one dismissed mailbox. It just refuses the two columns
-- that would resurrect the card.

create or replace function public.keep_ignored_calendar_ignored()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.ignored_at is not null then
    new.ignored_at := old.ignored_at;
    -- Without this the card reappears on /schedules: the page lists issues
    -- where resolved_at is null.
    new.resolved_at := coalesce(new.resolved_at, old.resolved_at, now());
    new.resolved_by := coalesce(new.resolved_by, old.resolved_by);
  end if;
  return new;
end;
$$;

comment on function public.keep_ignored_calendar_ignored() is
  'Preserves ignored_at/resolved_at when calendar-sync re-upserts a dismissed calendar. The sync writes resolved_at = null unconditionally on every run, which is what made "Not a school calendar" wear off after five minutes.';

drop trigger if exists calendar_sync_issues_keep_ignored on public.calendar_sync_issues;
create trigger calendar_sync_issues_keep_ignored
  before update on public.calendar_sync_issues
  for each row
  execute function public.keep_ignored_calendar_ignored();
