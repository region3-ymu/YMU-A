-- Phase 3: Google Calendar sync — calendar_events, calendar_sync_state,
-- notification_queue, fuzzy school matching (pg_trgm), and RLS.
--
-- All writes to these tables come from the sync Edge Function (service role)
-- except manual school assignment, which goes through the
-- assign_event_school() RPC (manager-gated, same pattern as promote_user).
-- Authenticated users only ever SELECT calendar_events.
--
-- Region model note (user-confirmed): a teacher's region(s) DERIVE from the
-- schools their events are at — teachers can span multiple regions, so
-- nothing here reads profiles.region for teachers. RM visibility of an event
-- keys off the event's school's region.

create extension if not exists pg_trgm with schema extensions;
-- For the 5-minute sync schedule (cron.schedule is a documented manual step
-- until the Edge Function is deployed — see HANDOFF.md).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- calendar_events — one row per concrete event instance (recurring events are
-- expanded with singleEvents=true, so google_event_id is the instance id).
-- Cancelled/deleted events keep their row with status='cancelled' so change
-- detection stays idempotent and Phase 8 reports can see what was cancelled.
-- ---------------------------------------------------------------------------

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  calendar_id text not null,
  google_event_id text not null unique,
  ical_uid text,
  recurring_event_id text,
  summary text,
  description text,
  location_raw text,
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean not null default false,
  -- 'confirmed' | 'tentative' | 'cancelled' (Google's event status verbatim)
  status text not null default 'confirmed',
  html_link text,
  organizer_email text,
  -- Raw attendee list as Google sends it: [{email, displayName,
  -- responseStatus, optional}] — the detail view mirrors this.
  attendees jsonb not null default '[]'::jsonb,
  -- Every attendee whose email matched a login email. An array, not a single
  -- column: an event with the regular teacher plus a substitute simply has
  -- two matched teachers — Google has no primary/sub distinction to import.
  teacher_ids uuid[] not null default '{}',
  school_id uuid references public.schools (id) on delete set null,
  school_match_score real,
  -- 'fuzzy' | 'manual' | null (null = unmatched). Manual survives re-syncs
  -- unless the event's Location text itself changes.
  school_match_source text,
  google_updated_at timestamptz,
  -- Full event payload for the detail view / debugging; the columns above are
  -- the queryable projection.
  raw jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.calendar_events is
  'Google Calendar event instances, synced by supabase/functions/calendar-sync. teacher_ids = attendees matched by login email; school via fuzzy Location match or manual assignment.';

create index calendar_events_start_at_idx on public.calendar_events (start_at);
create index calendar_events_teacher_ids_idx on public.calendar_events using gin (teacher_ids);
create index calendar_events_school_id_idx on public.calendar_events (school_id);

create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- calendar_sync_state — one row per synced calendar (in practice: one).
-- ---------------------------------------------------------------------------

create table public.calendar_sync_state (
  calendar_id text primary key,
  sync_token text,
  full_synced_at timestamptz,
  last_synced_at timestamptz,
  -- 'ok' | 'error'
  last_status text,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.calendar_sync_state is
  'syncToken bookkeeping for incremental Google Calendar sync. A 410 GONE from Google clears sync_token and forces a full resync.';

create trigger calendar_sync_state_touch_updated_at
  before update on public.calendar_sync_state
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- notification_queue — change detection writes rows here; Phase 7 builds the
-- dispatcher that drains them (Web Push + Resend email backup). Kept generic
-- (type + payload) so Phase 7's reminder types reuse the same table.
-- ---------------------------------------------------------------------------

create table public.notification_queue (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  event_id uuid references public.calendar_events (id) on delete set null,
  -- Phase 3 types: 'time_changed' | 'location_changed' | 'teacher_changed'
  -- | 'event_cancelled'. Phase 7 adds reminder types. Text, not an enum —
  -- only the service-role sync code writes here.
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  -- 'pending' | 'sent' | 'failed' — only 'pending' is written until Phase 7.
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.notification_queue is
  'Queued notifications. Phase 3 only enqueues (schedule-change detection); Phase 7 dispatches.';

create index notification_queue_pending_idx
  on public.notification_queue (created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.calendar_events enable row level security;
revoke all on table public.calendar_events from anon, authenticated;
grant select on table public.calendar_events to authenticated;
grant all on table public.calendar_events to service_role;

-- Teacher: only events they're matched into. RM: events at schools in their
-- region or at region-less schools, plus unmatched events (school unknown ⇒
-- region unknowable, and the unmatched queue is every manager's to triage).
-- OM/CPO: everything. The school-region check is written out explicitly
-- rather than leaning on schools' own RLS inside a subquery, so this policy
-- reads as the single source of truth for event visibility.
create policy calendar_events_select on public.calendar_events
  for select to authenticated
  using (
    auth.uid() = any (teacher_ids)
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
          where s.id = calendar_events.school_id
            and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
  );

-- No INSERT/UPDATE/DELETE policies: authenticated writes are impossible
-- (grants stop at select); the sync runs as service role, and manual school
-- assignment goes through assign_event_school() below.

alter table public.calendar_sync_state enable row level security;
revoke all on table public.calendar_sync_state from anon, authenticated;
grant all on table public.calendar_sync_state to service_role;

alter table public.notification_queue enable row level security;
revoke all on table public.notification_queue from anon, authenticated;
grant all on table public.notification_queue to service_role;

-- ---------------------------------------------------------------------------
-- Fuzzy school matching. normalize_location strips punctuation/case so
-- "Coral Gables Senior High School, 450 Bird Rd, Coral Gables, FL 33146"
-- and a school named "Coral Gables Senior High School" compare cleanly.
-- word_similarity(name, location) scores how well the school name matches
-- the best substring of the location (names are usually embedded in a longer
-- "Name, street, city" string, where plain similarity() scores poorly);
-- similarity(address, location) catches events whose Location is just the
-- street address. Called only by the sync (service role) — one call per
-- new/location-changed event, so the seq scan over ≤255 schools is fine.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_location(t text)
returns text
language sql
immutable
parallel safe
as $$
  select trim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function public.match_school(location_text text)
returns table (school_id uuid, school_name text, score real)
language sql
stable
set search_path = ''
as $$
  select s.id,
         s.name,
         greatest(
           extensions.word_similarity(
             public.normalize_location(s.name),
             public.normalize_location(location_text)
           ),
           extensions.similarity(
             public.normalize_location(s.address),
             public.normalize_location(location_text)
           )
         )::real as score
  from public.schools s
  where public.normalize_location(location_text) <> ''
  order by score desc, s.name
  limit 1;
$$;

revoke execute on function public.match_school(text) from public, anon, authenticated;
grant execute on function public.match_school(text) to service_role;

-- ---------------------------------------------------------------------------
-- Manual school assignment from the unmatched-event queue. SECURITY DEFINER
-- because authenticated users have no UPDATE grant on calendar_events; the
-- role/region checks below are therefore the entire authorization story
-- (same pattern as promote_user). RMs may only assign schools they can see
-- (own region or region-less); OM/CPO may assign any school.
-- ---------------------------------------------------------------------------

create or replace function public.assign_event_school(
  p_event_id uuid,
  p_school_id uuid
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
    raise exception 'only managers can assign a school to an event';
  end if;

  select region into strict v_school_region
  from public.schools where id = p_school_id;

  if v_role = 'regional_manager'
     and v_school_region is not null
     and v_school_region is distinct from public.current_app_region()
  then
    raise exception 'regional managers can only assign schools in their own region';
  end if;

  update public.calendar_events
     set school_id = p_school_id,
         school_match_source = 'manual',
         school_match_score = null
   where id = p_event_id;

  if not found then
    raise exception 'event not found';
  end if;
end;
$$;

revoke execute on function public.assign_event_school(uuid, uuid) from public, anon;
grant execute on function public.assign_event_school(uuid, uuid) to authenticated;
