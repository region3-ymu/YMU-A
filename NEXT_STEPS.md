# NEXT_STEPS — YMU-A

Where to pick up. Phase 3 (Google Calendar sync, Schedules tab) is built. **Multi-calendar sync is live-verified against the real service account, the real ~72-school roster, and the real 68 shared school calendars.** Current state: **50/68 calendars pinned to a school**, **17 genuinely open** (catalogued in [`calendar-sync-open-issues.csv`](calendar-sync-open-issues.csv) — not committed, local review artifact), 1 dismissed (`schedule@ymu.org`, not a school calendar). Two real matching bugs were found and fixed against live data along the way — see `DECISIONS.md` ("Two more real bugs..."). Event-sync is still catching up: only 9/50 pinned calendars have completed their initial full sync so far (each `npm run sync:calendar` run has a 4-minute budget and picks up more next time) — run it a few more times, or deploy the cron, before expecting every school's events to show. Next after that is **Phase 4: Clocking flow (online) + in-app feedback gate** from the approved plan (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`).

## What's left for multi-calendar sync (in order)

1. **Work through `calendar-sync-open-issues.csv`** (17 rows, 3 categories — reasonable/no candidate, ambiguous ties, school-already-linked) via `/schedules`'s "Calendars needing attention" queue. Two were already resolved directly (Norland Senior High School → Miami Norland Senior HS; `schedule@ymu.org` dismissed).
2. **Keep running `npm run sync:calendar`** (or deploy the cron) until every pinned school's initial full sync completes — check `calendar_sync_state.last_status`.
3. Validate `CALENDAR_MATCH_THRESHOLD`/`AMBIGUITY_MARGIN` (`supabase/functions/calendar-sync/sync.ts`) against the real auto-match/issue split — still untuned placeholders (0.5/0.08), though the current ~74% auto-match rate (50/68) suggests they're roughly reasonable.
4. Pick one school's calendar, edit/move/delete a test event there (matching Location, a teacher's login email as attendee), re-run `npm run sync:calendar`, confirm the change reflects in `/schedules` and a `notification_queue` row exists for that teacher.
5. Deploy the Edge Function + schedule the 5-min cron (HANDOFF "Manual steps").
Then flip the HANDOFF "pending" note to verified.

## Onboarding a new school's calendar (recurring runbook, not just first-time)

Discovered live: sharing a calendar with the service account (Apps Script bulk-share) grants it real access immediately, but does **not** make it discoverable — Google's calendarList (what `syncAllCalendars` uses to find calendars) is separate from ACL access, and a service account has no UI to "subscribe" itself the way a human does when accepting a share. So onboarding any new school's calendar is two steps, not one:
1. Share the calendar with `ymu-calendar-sync@cosmic-antenna-502619-u6.iam.gserviceaccount.com` (Apps Script bulk-share script, or manually via Calendar's sharing UI for a single new school).
2. Run `node --env-file=.env.local scripts/subscribe-calendars.ts <calendar-ids.json>` with the new calendar id(s) — this is what actually makes it discoverable. Safe to re-run with the full list any time (idempotent). See `DECISIONS.md` ("`calendarList` vs ACL") for why this exists.

## Phase 4 scope (from the plan)

**Build**: Clocking tab — next-class card (time in/out, date, school); Clock-In → browser geolocation (permission-denied / GPS-off / low-accuracy states with retry) → Leaflet map (teacher pin, school pin, 200 m circle) → haversine check → allow/deny with "move closer"; precise clock-in timestamp; status (on-time ±5 min, late after +5, configurable); Clock-Out gated by the **in-app feedback form** (unsubmitted form persists as a blocking "Demand" across logout/login and blocks the next clock-in).

**Files**: `app/clocking/*`, `components/geo-map.tsx`, `lib/attendance/status.ts`, `app/feedback/*`, `supabase/migrations/0008_attendance.sql` (next number after `0007_calendar_sync_issues.sql`, added by the multi-calendar sync work — see below).

**Done when**: full clock-in→teach→feedback→clock-out cycle works on a phone at a real (or devtools-spoofed) location; out-of-range denial verified; logging out with a pending form re-prompts on login.

## Things Phase 3 leaves that Phase 4 should know

- **The teacher↔school link now exists** via `calendar_events` (`teacher_ids`, `school_id`, `start_at`/`end_at`). Phase 4's "next class" card is a query over it: the caller's upcoming non-cancelled event with a matched `school_id`. The `page.tsx` in `schedules/` shows the exact select shape.
- **Reuse the geofence primitives**: `schools.lat/lng` + `geofence_radius_m` (default 200) and the SQL `haversine_meters()` — Phase 4 should call the SQL function server-side for the authoritative in-fence check, and the TS `haversineMeters()` client-side for the live "move closer" UI. Don't reimplement either.
- **Teachers can already read their scheduled schools' coordinates**: the `schools_select` policy was extended with `teacher_has_scheduled_school()` (see `0006`), so a teacher's client can fetch the school pin for the map without a manager RPC. That was added specifically so Phase 4's clock-in map works under RLS.
- **Leaflet marker icons**: reuse the `public/leaflet/*.png` string-URL pattern from `src/app/(app)/lists/leaflet-map.tsx` (a static `import` throws `iconUrl not set` under this Turbopack version) for the clock-in map.
- **Region is derived from events, not `profiles`** (user-confirmed): a teacher's region(s) come from the schools their events are at, so `profiles.region` was left untouched. If Phase 8 reports need per-teacher region rollups, derive them from `calendar_events → schools.region` (a teacher can be in several).
- **`notification_queue` is ready for Phase 7**: `type` + `payload` + `send_at` + `status`. Phase 3 writes `time_changed`/`location_changed`/`teacher_changed`/`event_cancelled`; Phase 7 adds reminder types and the dispatcher. Don't change its shape without checking `sync.ts`'s `queueNotifications`.
- **`school_years`** still standalone (unused until Phase 9).
- **Migration numbering**: `0007_calendar_sync_issues.sql` (multi-calendar sync, see below) is taken; next available is `0008_...`.
- **RLS tests**: `npm run test:rls` runs four files (profiles, schools, events, calendar-sync-issues); widen the glob again if adding `tests/attendance-rls.test.ts`. Non-hosted unit tests (no credentials needed) run via plain `npm run test`.

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale.
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.
- **Phase 3 + multi-calendar sync finishers** (above): Google service account + each school's calendar shared to it; deploy `calendar-sync` + set Edge secrets (no `GOOGLE_CALENDAR_ID`); schedule the 5-min `pg_cron` job.
