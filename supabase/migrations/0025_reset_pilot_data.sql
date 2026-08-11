-- Reset the pilot/PD-week data ahead of the official 2026-08-12 launch.
--
-- The relay week and every prior round of manual QA left real rows in the
-- attendance tables. None of it is production data: it is test clock-ins, the
-- GPS samples they spawned, the flags those raised, and the notifications that
-- were dispatched about them. Wiping it means the first real day starts from a
-- clean slate, so the Dashboard's "late", "missing clock-ins" and "pending
-- feedback" counters mean what they say on day one.
--
-- Deliberately NOT touched: schools, calendar_events, calendar_sync_state,
-- calendar_sync_issues, school_years, profiles, push_subscriptions,
-- notification_preferences, app_feedback. The whole point is that the roster,
-- the schedule and the accounts survive.

begin;

-- Order matters only for gps_checks -> attendance_sessions (no ON DELETE
-- CASCADE there); the rest are independent. Truncate is avoided because these
-- tables are referenced by FKs and the row counts are trivial.
delete from public.gps_checks;
delete from public.flags;
delete from public.notification_queue;
delete from public.attendance_sessions;

-- ---------------------------------------------------------------------------
-- "Seed Test School" is not just a stray fixture — it is squatting on a real
-- school's Google Calendar.
--
-- scripts/seed-test-data.ts creates it with a 100 km geofence (so QA can clock
-- in from anywhere). Because its name fuzzy-matched "SEED School of Miami",
-- calendar-sync pinned it to that school's real calendar
-- (c_8ff0aa3e...@group.calendar.google.com) and has been syncing that school's
-- events onto the fixture ever since.
--
-- Deleting the row would drop the calendar pin and orphan the synced events
-- (schools.id is ON DELETE SET NULL everywhere), pushing them into the
-- unmatched-event queue. Converting it in place is strictly better: the pin,
-- the sync state and the events all stay attached, and the 100 km hole closes.
--
-- lat/lng are cleared on purpose. A school with no coordinates makes clock_in()
-- fail with a clear geofence error, which is the honest state until the address
-- below is geocoded — far better than leaving the fixture's fake coordinates
-- paired with a real school. Geocoding happens in the school-import pass.
update public.schools
   set name = 'SEED School of Miami',
       address = '1901 NW 127th Street, Miami, FL 33167',
       region = 'north',
       geofence_radius_m = 200,
       lat = null,
       lng = null,
       geocode_source = null
 where name = 'Seed Test School';

-- Long-standing typo in the roster: the school is Arcola Lake, not Archola.
update public.schools
   set name = 'Arcola Lake Elementary School'
 where name = 'Archola Lake Elementary School';

commit;
