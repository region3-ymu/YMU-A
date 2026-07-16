# NEXT_STEPS — YMU-A

Where to pick up. Phase 3 (Google Calendar sync, Schedules tab) is **built and verified at every layer except the live-Google end-to-end**, which is blocked on the service-account credentials YMU is setting up — see `HANDOFF.md` ("Still owed"). Next is **Phase 4: Clocking flow (online) + in-app feedback gate** from the approved plan (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`).

## Finish Phase 3 first (small, credential-gated)

Once `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` + `GOOGLE_CALENDAR_ID` are in `.env.local` and the calendar is shared to the service account:
1. `npm run sync:calendar` — initial full sync; confirm rows land in `calendar_events` and the Schedules tab shows them.
2. Edit/move/delete a test event (matching Location, a teacher's login email as attendee), re-run `npm run sync:calendar`, confirm the change reflects in-app and a `notification_queue` row exists for that teacher.
3. Deploy the Edge Function + schedule the 5-min cron (HANDOFF "Manual steps").
Then flip the HANDOFF "pending" note to verified.

## Phase 4 scope (from the plan)

**Build**: Clocking tab — next-class card (time in/out, date, school); Clock-In → browser geolocation (permission-denied / GPS-off / low-accuracy states with retry) → Leaflet map (teacher pin, school pin, 200 m circle) → haversine check → allow/deny with "move closer"; precise clock-in timestamp; status (on-time ±5 min, late after +5, configurable); Clock-Out gated by the **in-app feedback form** (unsubmitted form persists as a blocking "Demand" across logout/login and blocks the next clock-in).

**Files**: `app/clocking/*`, `components/geo-map.tsx`, `lib/attendance/status.ts`, `app/feedback/*`, `supabase/migrations/0007_attendance.sql` (next number after `0006_events.sql`).

**Done when**: full clock-in→teach→feedback→clock-out cycle works on a phone at a real (or devtools-spoofed) location; out-of-range denial verified; logging out with a pending form re-prompts on login.

## Things Phase 3 leaves that Phase 4 should know

- **The teacher↔school link now exists** via `calendar_events` (`teacher_ids`, `school_id`, `start_at`/`end_at`). Phase 4's "next class" card is a query over it: the caller's upcoming non-cancelled event with a matched `school_id`. The `page.tsx` in `schedules/` shows the exact select shape.
- **Reuse the geofence primitives**: `schools.lat/lng` + `geofence_radius_m` (default 200) and the SQL `haversine_meters()` — Phase 4 should call the SQL function server-side for the authoritative in-fence check, and the TS `haversineMeters()` client-side for the live "move closer" UI. Don't reimplement either.
- **Teachers can already read their scheduled schools' coordinates**: the `schools_select` policy was extended with `teacher_has_scheduled_school()` (see `0006`), so a teacher's client can fetch the school pin for the map without a manager RPC. That was added specifically so Phase 4's clock-in map works under RLS.
- **Leaflet marker icons**: reuse the `public/leaflet/*.png` string-URL pattern from `src/app/(app)/lists/leaflet-map.tsx` (a static `import` throws `iconUrl not set` under this Turbopack version) for the clock-in map.
- **Region is derived from events, not `profiles`** (user-confirmed): a teacher's region(s) come from the schools their events are at, so `profiles.region` was left untouched. If Phase 8 reports need per-teacher region rollups, derive them from `calendar_events → schools.region` (a teacher can be in several).
- **`notification_queue` is ready for Phase 7**: `type` + `payload` + `send_at` + `status`. Phase 3 writes `time_changed`/`location_changed`/`teacher_changed`/`event_cancelled`; Phase 7 adds reminder types and the dispatcher. Don't change its shape without checking `sync.ts`'s `queueNotifications`.
- **`school_years`** still standalone (unused until Phase 9).
- **Migration numbering**: next is `0007_...`.
- **RLS tests**: `npm run test:rls` runs the three files; widen the glob again if adding `tests/attendance-rls.test.ts`.

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale.
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.
- **Phase 3 finishers** (above): Google service account + shared calendar; deploy `calendar-sync` + set Edge secrets; schedule the 5-min `pg_cron` job.
