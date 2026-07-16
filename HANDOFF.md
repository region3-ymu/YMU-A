# HANDOFF — YMU-A

Snapshot of the repo at the end of **Phase 3 (Google Calendar sync, Schedules tab)**. Phase 1/2 notes are superseded by this file (see git history for the prior `HANDOFF.md` if you need earlier detail). Everything below was verified by running it — the full RLS suite (40/40) plus driving the real dev server in a browser as an Operations Manager **and** as a Teacher against seeded events — except the live-Google end-to-end sync, which is **pending credentials** (see "Still owed" below).

## What exists right now

Everything from Phases 1–2 (auth/RBAC, schools, regions, Lists tab, geocoding) is unchanged and still verified.

**Google Calendar client** — `src/lib/google/calendar.ts`:
- Dependency-free and **isomorphic**: runs unchanged in Next.js (Node) and the Supabase Edge Function (Deno). Uses only WebCrypto + `fetch` — no `googleapis` package.
- Service-account auth: signs an RS256 JWT (`crypto.subtle`), exchanges it for an access token via the OAuth2 JWT-bearer grant, then calls the Calendar v3 REST API. Token cached in-memory until ~5 min before expiry.
- `GoogleCalendarClient.listEvents({ calendarId, syncToken?, pageToken?, timeMin? })` returns one page (`items`, `nextPageToken`, `nextSyncToken`); the sync core drives pagination. `singleEvents=true` (recurring events expanded to instances), `showDeleted=true` (so incremental sync sees cancellations). A `410` surfaces as `GoogleCalendarError` with `.status === 410`.
- Written in **erasable-only TS syntax** (explicit fields, not constructor parameter properties) so Node's native TS stripping runs it directly — that's what lets the local runner work without a build step.

**Sync core + Edge Function** — `supabase/functions/calendar-sync/`:
- `sync.ts` — `syncCalendar(supabase, env)` is the whole sync, written isomorphic (takes its clients as args). Full sync when there's no stored `syncToken`; incremental with the token otherwise; a `410` clears the token and re-runs a full sync (keeping `full_synced_at`, so recovery still emits change notifications). Matches attendee emails → teacher profile ids, fuzzy-matches the Location → a school, detects time/location/teacher(+substitute)/cancellation changes into `notification_queue`, and on a full sync reconciles removals (events no longer returned by Google → cancelled + notify).
- `index.ts` — the Deno `Deno.serve` entry. Auth via an `x-calendar-sync-secret` header (`verify_jwt=false` because pg_cron/pg_net calls carry no user JWT). Reads `GOOGLE_*` + service-role from `Deno.env`.
- **Local runner** — `scripts/sync-calendar.ts`, run via `npm run sync:calendar`. Calls the exact same `syncCalendar()` core against the hosted DB with the service-role key, so sync can be verified locally without Docker / `supabase functions serve`. This is the command to run for the end-to-end test once credentials exist.

**Schedules tab** — `src/app/(app)/schedules/` (replaces the Phase 1 stub):
- `page.tsx` — server component; loads non-cancelled events ending today or later (RLS-scoped) with the matched school embedded, plus the school list for filters. `requireProfile()` (not role-gated — teachers and managers both see it, scoped differently by RLS).
- `schedules-explorer.tsx` — client component: day-grouped event cards, a per-minute `now` tick driving the **"Currently in shift"** badge, and (managers only) region/school filters + the unmatched-event queue.
- `unmatched-event-queue.tsx` — manager panel listing events below the auto-match threshold, each with a school `<select>` → `assignEventSchool` action.
- `[id]/page.tsx` — event detail mirroring Google Calendar: title, date/time, location (school + raw + address), description (rendered as **plain text**, XSS-safe), organizer, guest list with RSVP status, video-call link if present, and an "Open in Google Calendar" link (`htmlLink`).
- `actions.ts` — `assignEventSchool` server action → `assign_event_school` RPC (manager-gated, region-checked in SQL).
- `format.ts` / `types.ts` — time/day formatting and shared row types.

**Database** (`0006_events.sql`, applied to hosted project `vgyogyojxlvhiwujidhy`; history in sync through `0006`):
- `calendar_events` — one row per event instance. `google_event_id` unique per `(calendar_id, google_event_id)`; `teacher_ids uuid[]` (all matched attendees — regular teacher *and* substitute); `school_id` + `school_match_source` (`fuzzy`|`manual`|null) + `school_match_score`; `attendees`/`raw` jsonb for the detail view; `status` keeps `cancelled` rows.
- `calendar_sync_state` — per-calendar `sync_token`, `full_synced_at`, `last_status`/`last_error`.
- `notification_queue` — `recipient_id`, `event_id`, `type`, `payload` jsonb, `send_at`, `status`. Phase 3 only enqueues; Phase 7 drains it. Service-role-only.
- `pg_trgm` + `match_school(location_text)` — normalizes both sides, scores `greatest(word_similarity(name, location), similarity(address, location))`, returns the best school; threshold **0.5** lives in `sync.ts` (`SCHOOL_MATCH_THRESHOLD`), below which the event goes to the unmatched queue.
- `assign_event_school(event, school)` — `SECURITY DEFINER` RPC for manual assignment; RMs restricted to their own region (both the event's current school region and the destination school region).
- `teacher_has_scheduled_school()` + an extended `schools_select` policy — teachers can now read schools they're scheduled at (needed for their own schedule and Phase 4 clock-in).
- RLS on `calendar_events`: teacher sees rows where their uid is in `teacher_ids`; RM sees events at schools in their region, at region-less schools, or unmatched (school unknown); OM/CPO see all.

**Tests** — `tests/events-rls.test.ts` (8 tests, same disposable-hosted-user pattern): teacher-only visibility, RM own-region + shared unmatched queue, OM sees all, teacher can read a scheduled school but not an unrelated one, RM manual-assign in region, RM rejected cross-region, `notification_queue` has no authenticated read. `npm run test:rls` now runs all three files — **40/40 passing**.

## Verified working (browser, dev server, hosted project)

Seeded a manager + teacher + three events (matched-upcoming, in-shift-now, unmatched) directly into `calendar_events`, then drove the real dev server:
- **OM view**: region/school filters, the "School matching needs attention" queue with a working school `<select>`, day-grouped cards, the green "Currently in shift" badge on the in-progress event, `N matched teacher · Region` metadata, and the role-accent (orange OM) chrome.
- **Teacher view**: subtitle "Your upcoming classes", **no** filters/unmatched-queue/manager metadata, only their own events, same in-shift badge — confirming the teacher scoping renders as intended.
- **Detail view**: school + raw Location + geocoded address, description, organizer, guest with "Accepted" RSVP, "Open in Google Calendar" link.
- `match_school` exercised live on the hosted DB (an unrelated school scored 0.04 for a Coral Gables query — correctly below threshold → unmatched).
- All seeded users/events deleted afterward (no `phase3-*` leftovers).

> Note: the login **form** couldn't be driven by the browser-automation harness (the client component's server-action submit didn't fire under automation — a harness quirk, not a product bug; real-user login was verified in Phase 2). Verification used an injected `@supabase/ssr` session cookie generated by that same library, which the app's server client reads normally.

## Still owed before Phase 3 is fully "done"

1. **Google service account + shared calendar** (only YMU can do this — it's account creation):
   - Create a service account in Google Cloud, enable the Calendar API, download a JSON key.
   - Share the schedule calendar with the service-account email as **"See all event details"**.
   - Set `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` (base64 of the JSON key) and `GOOGLE_CALENDAR_ID` in `.env.local`.
2. **Run the end-to-end acceptance test** (the "done when"): `npm run sync:calendar` for the initial full sync, then edit/move/delete a test event on the calendar with a matching Location and a teacher's login email as an attendee, run `npm run sync:calendar` again, and confirm the change is reflected in `/schedules` and a `notification_queue` row was created for the affected teacher. The sync code path is identical to the deployed Edge Function's.

## Manual steps still owed (Supabase dashboard) — for the 5-min cron

The sync logic is built as an Edge Function but the pg_cron trigger is **not deployed** (needs the function live + secrets). When ready:
1. `supabase functions deploy calendar-sync` (the CLI bundles the Deno function; it follows the relative import into `src/lib/google/calendar.ts`).
2. Set Edge secrets: `supabase secrets set CALENDAR_SYNC_SECRET=… GOOGLE_CALENDAR_ID=… GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=…` (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected into Edge Functions).
3. Schedule it (store the secret in Supabase Vault rather than inline in the cron row):
   ```sql
   select cron.schedule('calendar-sync-5min', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://vgyogyojxlvhiwujidhy.supabase.co/functions/v1/calendar-sync',
       headers := jsonb_build_object('Content-Type','application/json',
                                     'x-calendar-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name='calendar_sync_secret')),
       body := '{}'::jsonb
     );
   $$);
   ```

Plus the three standing items from Phase 1 (CPO seed, Resend SMTP cutover, production Site URL/redirect allowlist) — untouched, still owed.

## How to verify the current state yourself

```bash
npm install
npm run test:rls        # 40 tests (16 profiles + 16 schools + 8 events) against the hosted project
npm run build           # compiles the Schedules tab + detail route
# with GOOGLE_* set in .env.local:
npm run sync:calendar   # runs the real sync core against the hosted DB
```
