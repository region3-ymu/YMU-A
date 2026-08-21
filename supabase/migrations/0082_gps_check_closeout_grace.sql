-- ===========================================================================
-- 0082 — the GPS checks were losing a race with their own closeout
-- ===========================================================================
--
-- 649 of 654 GPS checks are 'unverifiable' with no distance recorded. Only 4
-- ever produced a position. The feature that is supposed to answer "did the
-- teacher stay for the class" has answered it four times.
--
-- ── The race ─────────────────────────────────────────────────────────────
--
-- close_out_overdue_gps_checks() marks anything `pending and due_at < now()`
-- as unverifiable, and the check-closeout cron runs EVERY MINUTE. So a check
-- due at 14:15:00 is closed by about 14:15:59.
--
-- The sampler (src/components/gps-check-sampler.tsx) polls every 30 seconds
-- and only samples checks whose due_at has already passed, then waits up to 15
-- seconds for a GPS fix. Best case it needs a few seconds; worst case it needs
-- 45. Against a one-minute closeout that is a coin flip.
--
-- The four that survived are the tell. Every one was sampled 18-33 seconds
-- after it came due:
--
--   James Perez           +33s
--   Osvaldo Lichtenzweig  +31s
--   Linda Rodriguez       +18s
--   Reinaldo Velez        +18s
--
-- Nothing later than 33 seconds has ever been recorded, because nothing later
-- than about a minute could be.
--
-- ── What this fixes, and what it does not ────────────────────────────────
--
-- A ten-minute grace turns a coin flip into a window. A check due at +15 stays
-- open until +25, so the sampler gets roughly twenty attempts instead of one.
--
-- It does NOT make the feature reliable, and that should be said plainly: the
-- sampler is foreground-only by design and stops the moment the phone locks
-- (see its own comment). Nobody holds a phone open for eighty minutes while
-- teaching a band class. This raises the ceiling for a teacher who glances at
-- the app mid-class from "nearly impossible" to "likely"; making it work
-- unattended needs a background-sync design that does not exist yet, and that
-- is a decision about whether the feature is worth having at all.
--
-- Grace is safe in the direction that matters. A later sample is not a more
-- forgiving one — distance_m is still measured against the school's geofence,
-- so a teacher who has already left records a position that says so. The only
-- thing lost by waiting is the precision of "at exactly +15 minutes", which
-- nothing reads.
-- ===========================================================================

-- Dropped before the new one is created, not after. `create or replace` with a
-- defaulted parameter makes a NEW function rather than replacing the
-- zero-argument original, and while both exist a bare
-- close_out_overdue_gps_checks() call is ambiguous — which is exactly what the
-- check-closeout Edge Function sends every minute. Once the old signature is
-- gone the defaulted parameter stands in for it, so that cron keeps working
-- unchanged and now means "with ten minutes of grace".
drop function if exists public.close_out_overdue_gps_checks();

create or replace function public.close_out_overdue_gps_checks(
  p_grace_minutes integer default 10
)
returns integer
language sql
set search_path = ''
as $$
  with updated as (
    update public.gps_checks
       set status = 'unverifiable'
     where status = 'pending'
       -- Was `due_at < now()`, which gave the sampler under a minute.
       and due_at < now() - make_interval(mins => greatest(coalesce(p_grace_minutes, 10), 0))
     returning id
  )
  select count(*)::integer from updated;
$$;

comment on function public.close_out_overdue_gps_checks(integer) is
  'Marks pending GPS checks unverifiable once they are more than p_grace_minutes past due. The grace exists because the sampler polls every 30s and needs up to 15s for a fix, while this runs every minute — with no grace it closed almost every check before it could be answered.';

revoke execute on function public.close_out_overdue_gps_checks(integer) from public, anon, authenticated;
grant execute on function public.close_out_overdue_gps_checks(integer) to service_role;
