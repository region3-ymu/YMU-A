-- ===========================================================================
-- 0063 — is this class an afterschool class?
-- ===========================================================================
--
-- Routing by program_id would have been the obvious move and it does not work.
-- The After School program is also resolveProgram()'s catch-all (sort_order
-- 900), so 754 events land on it having matched nothing at all: "Walkthrough -
-- Edison Park", "Equipment", "Evaluations", "TEST - Name of Class", titles that
-- are just a teacher's name, six with no title. Handing all of that to the
-- afterschool manager would make her inbox useless on day one.
--
-- So the classification is its own thing, read off the calendar title and the
-- clock, in two tiers. Validated against all 18,883 events in the calendar: it
-- reproduces YMU's rulings (2026-08-18) with no misclassification.
--
--   strong — the title says it outright, at any hour.
--     "after school" / "afterschool" both appear because the titles changed
--     between school years: 2025-26 wrote "After School", 2026-27 writes
--     "Afterschool", and YMU asked for both to keep working. "aftreschool" is
--     a real typo on 36 live events at Little River; the calendars belong to
--     the schools, so it gets accepted rather than waited on.
--
--   weak — ambiguous, and only afterschool if it actually runs late.
--     This is the whole reason for two tiers. Carol City's marching band at
--     15:00 is afterschool; Homestead Middle's at 07:40-10:44 (90 events this
--     year) is a regular class. YMU: "Si el marching band es de mañana no es
--     afterschool entonces."
--
-- The cutoff cannot be applied to every tier. Redland Middle and South Dade
-- title classes "Marching Band - Afterschool" and start them at 12:00-12:30;
-- if the clock outranked the title those would be lost. The title is
-- authoritative, and the clock only breaks ties on what the title left vague.
--
-- What this deliberately does NOT match: "asd" / "special" (YMU: regular
-- classes, they stay with their region's RM), and the generic word "ensemble".
-- Leaving "ensemble" out is what keeps Citrus Grove's "Jazz Ensamble" (90
-- events, 10:10-11:30), Miami Beach's "Jazz" and Northwestern's "Jazz Band
-- Rhythm Section" out without needing an exception list — they are
-- school-hours classes and nothing here reaches them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The patterns, in a table
-- ---------------------------------------------------------------------------
-- In a table and not in the function body for the same reason
-- programs.match_patterns is: the Rock/Fusion ensembles at Miami Beach,
-- Fienberg, Nautilus and Coral Gables are confirmed afterschool but have zero
-- events this school year — YMU has not put them in the calendar yet. When
-- they appear they should classify themselves, without a migration and without
-- a deploy.

create table if not exists public.afterschool_patterns (
  -- Matched as a plain lowercase substring of the title, the same way
  -- programs.match_patterns is. No regex: two spellings are two rows, which is
  -- easier for a manager to read and edit than one clever pattern.
  pattern text primary key,
  tier text not null check (tier in ('strong', 'weak')),
  active boolean not null default true,
  note text
);

comment on table public.afterschool_patterns is
  'Title substrings that mark a calendar event as an afterschool class. tier=strong wins at any hour; tier=weak only counts when the class starts at or after the afternoon cutoff in classify_afterschool().';

insert into public.afterschool_patterns (pattern, tier, note) values
  ('after school',  'strong', '2025-26 spelling, two words'),
  ('afterschool',   'strong', '2026-27 spelling, one word'),
  ('aftreschool',   'strong', 'Live typo, 36 events at Little River K-8'),
  ('tutoring',      'strong', 'YMU 2026-08-18: tutoring counts as afterschool'),
  ('rock ensemble', 'strong', 'YMU 2026-08-18'),
  ('fusion',        'strong', 'YMU 2026-08-18; covers "Fusion Ensemble" and "Sunday Fusion"'),
  ('marching band', 'weak',   'Afternoon only — Homestead Middle runs one at 07:40 that is a regular class')
on conflict (pattern) do nothing;

alter table public.afterschool_patterns enable row level security;

revoke all on table public.afterschool_patterns from anon, authenticated;
grant select on table public.afterschool_patterns to authenticated;
grant all on table public.afterschool_patterns to service_role;

-- Readable by everyone signed in, writable by nobody through the API. The
-- classifier is SECURITY DEFINER so it does not depend on this policy; the
-- grant is so a manager can see WHY a class was classified the way it was.
create policy afterschool_patterns_select on public.afterschool_patterns
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 2. The classifier
-- ---------------------------------------------------------------------------

create or replace function public.classify_afterschool(
  p_summary text,
  p_start_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with title as (select lower(coalesce(p_summary, '')) as h)
  select
    -- strong: the title is authority, whatever the clock says.
    exists (
      select 1 from public.afterschool_patterns p, title t
       where p.active and p.tier = 'strong' and t.h like '%' || p.pattern || '%'
    )
    or (
      exists (
        select 1 from public.afterschool_patterns p, title t
         where p.active and p.tier = 'weak' and t.h like '%' || p.pattern || '%'
      )
      -- 13:30 rather than a rounder 14:00: Little River's "Tutoring" starts at
      -- 13:50 and is the earliest class that has to qualify. Local time, not
      -- UTC — "afternoon" is a fact about the school's clock, and a UTC
      -- comparison would also shift under daylight saving.
      and p_start_at is not null
      and (p_start_at at time zone 'America/New_York')::time >= time '13:30'
    );
$$;

comment on function public.classify_afterschool(text, timestamptz) is
  'True when a calendar title marks an afterschool class. Strong patterns match at any hour; weak patterns need a start at or after 13:30 America/New_York. See afterschool_patterns.';

revoke execute on function public.classify_afterschool(text, timestamptz) from public, anon;
grant execute on function public.classify_afterschool(text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stored on the event, maintained by trigger
-- ---------------------------------------------------------------------------
-- Stored rather than computed in each policy: eleven RLS policies consult it,
-- and a per-row regex on every policy evaluation is not something to pay for
-- on every read. The dependent tables (attendance, feedback, tickets, flags)
-- reach it through event_id instead of repeating the rule.
--
-- Note what is NOT stored here: the school year. The classification is a fact
-- about the class and does not expire, so baking today's school year into the
-- column would go stale the moment the year rolls over. The current-year
-- window belongs in the policies, where it is re-evaluated on every read —
-- see 0064.

alter table public.calendar_events
  add column if not exists is_afterschool boolean not null default false;

comment on column public.calendar_events.is_afterschool is
  'Derived by classify_afterschool() from summary + start_at on write. Never set by hand — fix the calendar title instead, which is the source of truth.';

create or replace function public.set_calendar_event_afterschool()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.is_afterschool := public.classify_afterschool(new.summary, new.start_at);
  return new;
end;
$$;

drop trigger if exists calendar_events_set_afterschool on public.calendar_events;

-- `of summary, start_at` keeps this off the hot path of the sync's other
-- column updates; those two are the only inputs the classifier reads.
create trigger calendar_events_set_afterschool
  before insert or update of summary, start_at on public.calendar_events
  for each row execute function public.set_calendar_event_afterschool();

-- Backfill. Guarded so re-running the migration is a no-op rather than a
-- full-table rewrite.
update public.calendar_events
   set is_afterschool = public.classify_afterschool(summary, start_at)
 where is_afterschool is distinct from public.classify_afterschool(summary, start_at);

-- The afterschool manager's every read is "afterschool classes, this school
-- year". Partial on the flag so the index carries only her rows.
create index if not exists calendar_events_afterschool_start_idx
  on public.calendar_events (start_at)
  where is_afterschool;
