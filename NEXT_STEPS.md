# NEXT_STEPS — YMU-A

Where to pick up. Phase 2 (schools, regions, Lists tab) is done and verified — see `HANDOFF.md`. Next is **Phase 3: Google Calendar sync** from the approved plan (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`).

## Phase 3 scope (from the plan)

**Build**: Service-account client; initial full sync then incremental `syncToken` sync via pg_cron→Edge Function every 5 min; event→teacher matching by attendee email ↔ login email; event→school fuzzy match on the event's Location field; unmatched-event queue for managers; Schedules tab (teacher sees own; managers see all / by region), "currently in shift" indicator, event detail view (mirrors what clicking in Google Calendar shows); change detection (teacher/sub/time/location changed or event removed) emitting rows into `notification_queue`.

**Files**: `lib/google/calendar.ts`, `supabase/functions/calendar-sync/`, `app/schedules/*` (replaces the Phase 1 stub at `src/app/(app)/schedules/`), `supabase/migrations/0006_events.sql` (next number after `0005_schools.sql`).

**Done when**: editing/moving/deleting an event in Google Calendar is reflected in-app within ~5 min and queues a notification row for the affected teacher.

## Things Phase 2 left that Phase 3 should know

- **This is where the teacher↔school link finally appears.** Phase 2 deliberately did *not* invent a manual teacher↔school assignment table (user-confirmed call — see DECISIONS) because Phase 3's event→teacher and event→school matching was always meant to be the real source of that link, via `calendar_events.teacher_id` / `calendar_events.school_id`. When this lands, revisit:
  - `src/app/(app)/lists/lists-explorer.tsx` — the Teachers section currently says "Grouped by region for now — per-school rosters arrive once Google Calendar sync (Phase 3) links teachers to schools via their scheduled events." Once `calendar_events` exists, consider adding a per-school roster derived from it.
  - `profiles_select` RLS policy (`0002_profiles_rls.sql`) — RM→teacher visibility still keys on `profiles.region`. Decide whether it should additionally/instead derive from schools in the RM's region once that link exists, and update `tests/rls.test.ts` if so.
- **Reuse, don't rebuild**: `requireRole()`/`requireProfile()` (`src/lib/auth/dal.ts`), `MANAGER_ROLES`/`REGIONS`/labels (`src/lib/auth/roles.ts`), `current_app_role()`/`current_app_region()` SQL helpers, and now also `schools` (id, name, address, lat/lng, region, geofence_radius_m) and `teacher_directory()` for anywhere Phase 3 needs a teacher's email (e.g. matching attendee email → login email) — don't re-derive it from `auth.users` again, the RPC already does the manager-gated version and a service-role Edge Function can just query `auth.users`/`profiles` directly since it bypasses RLS anyway.
- **Fuzzy school matching**: `schools.address` is a free-text string as typed by the manager (post-geocode); Google Calendar's Location field will be free text too. Budget time for picking a fuzzy-match approach (e.g. trigram similarity via `pg_trgm`, or a simpler normalized-substring match) — nothing in Phase 2 built this, `schools` just has the columns to match against.
- **`geofence_radius_m`** (default 200, editable per school via the Lists tab's contact editor) is unused until Phase 4/5's clock-in geofence check. `haversine_meters()` (SQL) and `haversineMeters()` (TS, `src/lib/geo/haversine.ts`) both exist and are unit-consistent (meters) — Phase 4 should call the SQL one server-side, not reimplement it.
- **Leaflet marker icons**: don't reintroduce a static `import` of `leaflet/dist/images/*.png` — it throws `iconUrl not set in Icon options` under this Next.js/Turbopack version. The fix already in place (`src/app/(app)/lists/leaflet-map.tsx`) serves them from `public/leaflet/*.png` as plain URL strings; reuse that pattern (or the same map components) for Phase 4's clock-in geo-map.
- **`school_years`** exists (table + RLS, OM/CPO write / all-managers read) but nothing links to it yet — Phase 2 left it standalone on purpose since no phase before Phase 9 (school-year lifecycle) consumes it. Don't feel obligated to wire it into `schools` or `calendar_events` unless Phase 3 actually needs it for something (e.g. scoping sync to a current school year).
- **Migration numbering**: next is `0006_...`.
- **RLS tests**: `npm run test:rls` runs `tests/rls.test.ts tests/schools-rls.test.ts`; widen the script glob again if adding `tests/events-rls.test.ts` or similar.

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale (built-in sender ≈ 2 emails/hour and rejects test domains).
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.
- **New for Phase 3**: `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` / `GOOGLE_CALENDAR_ID` env vars are still unset (placeholders exist in `.env.example`); someone at YMU needs to share a Google Calendar with the service-account email ("See all event details") before sync can run against anything real.

## After Phase 3

Phase 4 (Clocking flow) — needs `schools` (lat/lng, geofence_radius_m) for the geofence check and `calendar_events` for the "next class" card.
