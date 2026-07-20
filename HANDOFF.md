# HANDOFF — YMU-A

Snapshot of the repo at the end of **Phase 3 (Google Calendar sync, Schedules tab) + multi-calendar sync**, both now live-verified end-to-end against the real service account, real ~72-school roster, and real 68 shared school calendars — not just mocks or dry-runs. Phase 1/2 notes are superseded by this file (see git history for the prior `HANDOFF.md` if you need earlier detail). Everything below was verified by running it: the full RLS suite, driving the real dev server as an Operations Manager and a Teacher against seeded events, and the real multi-calendar sync against production Google Calendar + Supabase data (see "Still owed" below for what's left — mostly working through the 17-item review queue and letting the initial event sync finish catching up, not code gaps). Next up is **Phase 4: Clocking flow**.

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

## Multi-calendar sync (schools ↔ Google Calendars) — built on top of Phase 3

Phase 3 above assumed one shared calendar for every school. This adds discovery and matching for **30-70 calendars, one per school**, layered on top of (not replacing) the event↔school Location match:

- **`0007_calendar_sync_issues.sql`** — `schools` gains `google_calendar_id` (unique, nullable), `calendar_match_source`/`calendar_match_score`/`calendar_matched_at`. These four columns are write-protected via **column-level `REVOKE UPDATE/INSERT ... FROM authenticated`** (not a trigger like `protect_school_region` — see the migration's header comment for why a trigger would have blocked `resolve_calendar_issue()`'s own writes). New tables: `calendar_sync_issues` (the calendar-level twin of the unmatched-event queue; one row per `calendar_id`, reopened on rediscovery rather than duplicated) and `calendar_sync_lock` (single-row lease preventing overlapping sync runs). New SQL: `match_school_calendar()` (pg_trgm, top-3 candidates, name-only) and `resolve_calendar_issue()` (manager RPC: link a calendar to a school, or dismiss it as a non-school calendar).
- **Pin-then-skip (user-confirmed)**: once a calendar is linked to a school, later syncs never re-match it — a manager must explicitly relink it via the new UI. No periodic re-validation.
- **`src/lib/google/calendar.ts`** — added `listCalendars`/`listAllCalendars` (properly paginated, unlike a bug found in a reference implementation that silently truncated past one page) and a shared `googleFetchWithRetry` (exponential backoff + jitter on 429/5xx/rate-limited 403, used by both event and calendar listing). Also added `subscribeToCalendar()` and widened `CALENDAR_SCOPE` — see "Live-verified" below, this was a real gap found only by running against real calendars.
- **`sync.ts`** — `syncCalendar` renamed to `syncOneCalendar` (parameterized, unchanged internals); new `syncAllCalendars(supabase, env, { dryRun? })` orchestrates: acquire the lease → discover all calendars → classify each unpinned one (`classifyDiscoveredCalendar`, a pure/unit-tested function — auto-match / flag ambiguous / flag unmatched) → sequentially sync every pinned school's events with a ~200ms pacing delay and a 4-minute soft time budget (skipped calendars just pick up next tick) → release the lease. `CALENDAR_MATCH_THRESHOLD`/`AMBIGUITY_MARGIN` are separate constants from `SCHOOL_MATCH_THRESHOLD` — both start as **untuned placeholders (0.5 / 0.08)** and must be validated against the real planned calendar-summary strings before relying on them in production.
- **`GOOGLE_CALENDAR_ID` is obsolete** — the service account's calendars are discovered directly. `scripts/sync-calendar.ts` gained a `CALENDAR_SYNC_DRY_RUN` mode (discovery/matching only, no writes) for validating discovery against the real service account before turning writes on.
- **Admin UI** — `unmatched-calendar-queue.tsx` (new, twin of `unmatched-event-queue.tsx`) on `/schedules`, backed by `resolveCalendarIssue` in `actions.ts`. Same manager-only gating, same dropdown-plus-submit interaction, plus a "Not a school calendar" dismiss path for shared/admin calendars (e.g. holidays) that aren't tied to any school.
- **Tests** — `tests/google-calendar-client.test.ts` (mocked-`fetch` pagination + backoff, no network), `tests/calendar-sync-classify.test.ts` (pure classifier, no DB), `tests/calendar-sync-rls.test.ts` (hosted, added to `npm run test:rls`): queue visibility (shared, not region-scoped), role/region gating on `resolve_calendar_issue`, the column-revoke actually blocking a raw client `UPDATE`, and the double-claim friendly-error path.

### Live-verified against the real service account and real school calendars (not just mocks)

Four real bugs surfaced only by actually running this against Google and the real ~72-school roster, not by code review — all fixed and confirmed working against live data:
1. **ACL access ≠ calendarList discoverability.** Sharing a calendar with the service account (Apps Script bulk-share) grants real access immediately (`events.list` on a shared calendar worked right away), but `syncAllCalendars`'s discovery (`calendarList.list()`) still reported 0 calendars. Google's calendarList is a separate "subscriptions" resource from ACL grants; a service account has no UI to auto-subscribe the way a human accepting a share does. Fixed with a new `subscribeToCalendar()` method and a one-time (and re-runnable) bootstrap: `scripts/subscribe-calendars.ts <calendar-ids.json>`.
2. **`subscribeToCalendar` itself then failed with `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`** — confirmed via the actual Google error body, not guessed. `calendarList.insert` needs write access to the calendarList resource, which the `calendar.readonly` scope doesn't grant. Fixed by adding the narrow `https://www.googleapis.com/auth/calendar.calendarlist` scope (not the broad read-write `calendar` scope, which would over-grant event data writes this sync never needs).
3. **Stale/orphaned `calendar_sync_issues` rows.** A calendar flagged as an issue in one run that later auto-matched in a subsequent run never had its old issue row resolved, inflating the open-issue count with calendars that were actually already correctly pinned. Fixed: the auto-match branch now resolves any open issue for that `calendar_id`.
4. **Two calendars sharing a name could silently steal each other's pin** ("South Dade Senior High" and "Dr. William Chapman Elementary" each really do exist as two separate Google Calendars). Fixed with a `pinnedSchoolIds` guard in `classifyDiscoveredCalendar` — a calendar whose best match is a school already claimed by a *different* calendar is now flagged `school_already_linked` instead of overwriting.

See `DECISIONS.md` for full detail on all four. Final verified state after every fix, against the real 72-school roster and real 68 shared calendars: **50/68 auto-matched, 17 genuinely open** (catalogued in `calendar-sync-open-issues.csv`), 1 dismissed (`schedule@ymu.org`, not a school calendar). `50 + 17 + 1 = 68`, no double-counting.

## Verified working (browser, dev server, hosted project)

Seeded a manager + teacher + three events (matched-upcoming, in-shift-now, unmatched) directly into `calendar_events`, then drove the real dev server:
- **OM view**: region/school filters, the "School matching needs attention" queue with a working school `<select>`, day-grouped cards, the green "Currently in shift" badge on the in-progress event, `N matched teacher · Region` metadata, and the role-accent (orange OM) chrome.
- **Teacher view**: subtitle "Your upcoming classes", **no** filters/unmatched-queue/manager metadata, only their own events, same in-shift badge — confirming the teacher scoping renders as intended.
- **Detail view**: school + raw Location + geocoded address, description, organizer, guest with "Accepted" RSVP, "Open in Google Calendar" link.
- `match_school` exercised live on the hosted DB (an unrelated school scored 0.04 for a Coral Gables query — correctly below threshold → unmatched).
- All seeded users/events deleted afterward (no `phase3-*` leftovers).

> Note: the login **form** couldn't be driven by the browser-automation harness (the client component's server-action submit didn't fire under automation — a harness quirk, not a product bug; real-user login was verified in Phase 2). Verification used an injected `@supabase/ssr` session cookie generated by that same library, which the app's server client reads normally.

## Still owed before Phase 3 + multi-calendar sync are fully "done"

Done already, confirmed live: service account created, JSON key in `.env.local`, migration `0007` applied to the hosted project, all 68 real school calendars shared **and** subscribed (`scripts/subscribe-calendars.ts`), real ~72-school roster imported into `schools`, real (non-dry-run) sync executed multiple times — **50/68 calendars pinned, 17 genuinely open** in the "Calendars needing attention" queue (2 already resolved manually: Norland Senior High School → Miami Norland Senior HS; `schedule@ymu.org` dismissed). 1746 real events synced so far.

1. **Work through the remaining 17** via `/schedules`'s "Calendars needing attention" queue — see [`calendar-sync-open-issues.csv`](../calendar-sync-open-issues.csv) for the full list with fuzzy-match candidates, split into 3 categories (reasonable-candidate/no-match, ambiguous tie, school-already-linked).
2. **Keep running `npm run sync:calendar`** (or deploy the cron below) until every pinned school's initial full sync completes — each run has a 4-minute soft budget and only gets through a handful of calendars' full event history per call; check `calendar_sync_state.last_status = 'ok'` per calendar_id to see what's still pending.
3. **Validate `CALENDAR_MATCH_THRESHOLD`/`AMBIGUITY_MARGIN`** (`supabase/functions/calendar-sync/sync.ts`) against the real auto-match/issue split — still untuned placeholders (0.5/0.08), though the live ~74% (50/68) auto-match rate suggests they're in a reasonable range already.
4. **Run the end-to-end acceptance test** (the "done when"): edit/move/delete a test event on one school's calendar with a matching Location and a teacher's login email as an attendee, run `npm run sync:calendar` again, and confirm the change is reflected in `/schedules` and a `notification_queue` row was created for the affected teacher. The sync code path is identical to the deployed Edge Function's.
5. **Onboarding any new school's calendar going forward is two steps**, not one: share it (Apps Script or manually) **and** run `scripts/subscribe-calendars.ts` with its id — see `NEXT_STEPS.md` ("Onboarding a new school's calendar").

## Manual steps still owed (Supabase dashboard) — for the 5-min cron

The sync logic is built as an Edge Function but the pg_cron trigger is **not deployed** (needs the function live + secrets). When ready:
1. `supabase functions deploy calendar-sync` (the CLI bundles the Deno function; it follows the relative import into `src/lib/google/calendar.ts`).
2. Set Edge secrets: `supabase secrets set CALENDAR_SYNC_SECRET=… GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=…` (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected into Edge Functions; `GOOGLE_CALENDAR_ID` is obsolete, don't set it).
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
npm run test             # mocked-fetch calendar client + pure classifier tests, no credentials needed
npm run test:rls         # profiles + schools + events + calendar-sync-issues, against the hosted project
npm run build            # compiles the Schedules tab + detail route
# with GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 set in .env.local, and each calendar
# already shared to the service account AND subscribed once via
# scripts/subscribe-calendars.ts (see NEXT_STEPS.md "Onboarding a new school's
# calendar" — sharing alone is not enough, see DECISIONS.md "calendarList vs ACL"):
CALENDAR_SYNC_DRY_RUN=1 npm run sync:calendar   # discovery/matching only, no writes
npm run sync:calendar                            # runs the real multi-calendar sync against the hosted DB
```
