-- Multi-calendar sync: schools <-> Google Calendar matching (one calendar per
-- school, discovered from the service account's calendarList), separate from
-- and layered on top of Phase 3's existing event <-> school Location match.
--
-- Pin-then-skip (user-confirmed): once a calendar is matched to a school
-- (google_calendar_id set), later syncs never re-match it -- a manager must
-- explicitly change it via resolve_calendar_issue(). Unlike region's
-- protect_school_region() (0005), write protection here is NOT a trigger:
-- resolve_calendar_issue() is a SECURITY DEFINER RPC called by an
-- authenticated manager, so auth.uid() is never null inside it -- a trigger
-- keyed on "auth.uid() is not null" would block the RPC's own writes, not
-- just a raw client PATCH. Column-level privilege revocation has no such
-- ambiguity: it's checked against the executing role (authenticated vs. the
-- RPC's definer/owner), never against auth.uid()/JWT contents, so it blocks
-- direct client writes while leaving both the RPC and the service-role sync
-- (which already has a blanket `grant all ... to service_role`) unaffected.

-- ---------------------------------------------------------------------------
-- schools: the pin + its provenance
-- ---------------------------------------------------------------------------

alter table public.schools
  add column google_calendar_id text unique,
  add column calendar_match_source text, -- 'fuzzy' | 'manual' | null
  add column calendar_match_score real,
  add column calendar_matched_at timestamptz;

comment on column public.schools.google_calendar_id is
  'The Google Calendar id synced for this school. Set once by the sync (fuzzy match on calendar summary) or by a manager via resolve_calendar_issue(); never re-matched afterward (pin-then-skip).';

-- schools_update (0005) grants authenticated a blanket table-level UPDATE;
-- carve these four columns back out so only the table owner (i.e. the
-- SECURITY DEFINER resolve_calendar_issue() below) or service_role can write
-- them -- a manager can still edit contact info/geofence/etc. on the same
-- row, just not these fields directly.
revoke update (google_calendar_id, calendar_match_source, calendar_match_score, calendar_matched_at)
  on table public.schools from authenticated;
revoke insert (google_calendar_id, calendar_match_source, calendar_match_score, calendar_matched_at)
  on table public.schools from authenticated;

-- ---------------------------------------------------------------------------
-- calendar_sync_issues -- the calendar-level twin of the unmatched-event
-- queue: a discovered calendar that couldn't be auto-matched (or matched
-- ambiguously), for a manager to resolve. Rows are upserted in place on
-- rediscovery rather than duplicated (see the partial unique index below).
-- ---------------------------------------------------------------------------

-- One row per calendar_id, ever -- not a partial "open issues only" unique
-- index, because Supabase/PostgREST upserts (onConflict: "calendar_id")
-- infer a plain ON CONFLICT (calendar_id) target, which cannot match a
-- partial index. Rediscovering a previously-resolved calendar as an issue
-- again simply reopens this same row (resolved_at cleared) instead of
-- inserting a duplicate.
create table public.calendar_sync_issues (
  id uuid primary key default gen_random_uuid(),
  calendar_id text not null unique,
  calendar_summary text,
  -- 'no_matching_school' | 'ambiguous_match' | 'school_already_linked' | 'sync_error'
  reason text not null,
  -- Top-3 {school_id, school_name, score} candidates from
  -- match_school_calendar(), so the admin UI can explain an ambiguous match
  -- without a second query.
  candidates jsonb not null default '[]'::jsonb,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id)
);

comment on table public.calendar_sync_issues is
  'Calendars discovered by calendar-sync that could not be auto-matched to a school (or matched ambiguously), awaiting manager resolution via resolve_calendar_issue().';

alter table public.calendar_sync_issues enable row level security;
revoke all on table public.calendar_sync_issues from anon, authenticated;
grant select on table public.calendar_sync_issues to authenticated;
grant all on table public.calendar_sync_issues to service_role;

-- Not region-scoped, same reasoning as calendar_events_select's unmatched
-- case (0006): a calendar with no matched school has no knowable region, so
-- every manager triages the shared queue.
create policy calendar_sync_issues_select on public.calendar_sync_issues
  for select to authenticated
  using (public.current_app_role() in ('regional_manager', 'operations_manager', 'cpo'));

-- ---------------------------------------------------------------------------
-- calendar_sync_lock -- single-row lease preventing overlapping sync runs.
-- A lease row (not pg_advisory_lock) because Supabase Edge Function DB
-- connections aren't guaranteed to hold one long-lived session, which makes
-- session-scoped advisory locks unreliable there; this works over stateless
-- HTTP calls and self-heals (the lease just expires) if a run crashes.
-- ---------------------------------------------------------------------------

create table public.calendar_sync_lock (
  id boolean primary key default true,
  locked_until timestamptz,
  constraint calendar_sync_lock_single_row check (id)
);

comment on table public.calendar_sync_lock is
  'Single-row lease acquired by syncAllCalendars() to prevent two sync runs overlapping. Acquire with an atomic UPDATE ... WHERE locked_until IS NULL OR locked_until < now().';

insert into public.calendar_sync_lock (id, locked_until) values (true, null);

alter table public.calendar_sync_lock enable row level security;
revoke all on table public.calendar_sync_lock from anon, authenticated;
grant all on table public.calendar_sync_lock to service_role;

-- ---------------------------------------------------------------------------
-- match_school_calendar -- calendar-level twin of match_school (0006).
-- Returns the top 3 candidates (not top 1) so the caller can detect a tie
-- between two schools. Compares only against schools.name: a calendar
-- summary is a short, structured string ("Roosevelt Elementary"), not a
-- "name, street, city" string, so match_school's address-similarity half
-- doesn't apply here.
-- ---------------------------------------------------------------------------

create or replace function public.match_school_calendar(calendar_summary text)
returns table (school_id uuid, school_name text, score real)
language sql
stable
set search_path = ''
as $$
  select s.id,
         s.name,
         extensions.word_similarity(
           public.normalize_location(s.name),
           public.normalize_location(calendar_summary)
         )::real as score
  from public.schools s
  where public.normalize_location(calendar_summary) <> ''
  order by score desc, s.name
  limit 3;
$$;

revoke execute on function public.match_school_calendar(text) from public, anon, authenticated;
grant execute on function public.match_school_calendar(text) to service_role;

-- ---------------------------------------------------------------------------
-- resolve_calendar_issue -- calendar-level twin of assign_event_school
-- (0006): the only path (besides the service-role sync) allowed to write
-- schools.google_calendar_id / calendar_match_source / calendar_match_score /
-- calendar_matched_at. Same manager-role-gate + RM region-scoping shape.
--
-- p_school_id omitted -> dismiss-only (the calendar isn't a school calendar
-- at all, e.g. a shared "Holidays" calendar); the open issue is resolved and
-- no school is touched.
-- ---------------------------------------------------------------------------

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
         resolved_by = auth.uid()
   where calendar_id = p_calendar_id
     and resolved_at is null;
end;
$$;

revoke execute on function public.resolve_calendar_issue(text, uuid) from public, anon;
grant execute on function public.resolve_calendar_issue(text, uuid) to authenticated;
