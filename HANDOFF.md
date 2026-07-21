# HANDOFF — YMU-A

Snapshot of the repo at the end of **Phase 4 (Clocking flow + feedback gate)**, then reworked so feedback is a **Zoho-hosted form + webhook** instead of an in-app form (product change, PRD-confirmed — see callout below and DECISIONS.md). Phase 1/2 notes are superseded (see git history); Phase 3 + multi-calendar sync detail is retained below unchanged. Next up is **Phase 5**, after the Zoho-side setup in NEXT_STEPS.md ("Finish the Zoho feedback setup").

> **Feedback rework: Zoho-hosted form + webhook, not an in-app form.** The PRD calls for the class-feedback form to live in Zoho, embedded in the app; Zoho's own webhook (not the teacher's client) closes the attendance session. The first pass of this (RPC, webhook, offline draft, secret validation, idempotent retries — all exercised live via a simulated `curl` delivery) invented a feedback schema (1–5 rating, summary, challenges, students present) **without ever looking at the real Zoho form**. Once a screenshot of the real form surfaced, none of those fields existed on it — so the real form's HTML was fetched directly and its actual fields read out field-by-field (see DECISIONS.md for the full comparison): Teacher Name / School / Choose program (dropdowns), Date, a 5-choice student-engagement scale, a Yes/No "had an issue" question with a conditional issue-status follow-up, and optional notes. `close_session_from_zoho()` and the webhook were rebuilt to match this real schema exactly (migration `0011`), storing the engagement scale's exact text rather than inventing a numeric mapping (user-confirmed). **What's still unconfirmed**: no hidden `session_id` field exists on the real form yet (needed for the webhook to know which session a submission is for — see NEXT_STEPS.md for how to add it), nobody has filled out and submitted the real form yet so the actual webhook delivery is still only verified via simulated `curl`, and whether the school/teacher/date/program dropdown prefill actually applies on the real form (vs. Zoho silently ignoring it) hasn't been confirmed by a human looking at the rendered result. Two real bugs were found and fixed while building the webhook/proxy plumbing (see DECISIONS.md): the auth proxy was redirecting the webhook to `/login` (fixed by excluding `/api/*` from the proxy matcher), and a hydration mismatch from reading `navigator.onLine` at initial render (fixed by deferring the real value to an effect).
>
> **Two UX fixes on top, both user-requested after trying the flow live**: (1) clocking in now redirects to the home dashboard instead of straight into the feedback form — the home page's re-prompt banner and a "Clock out" nav tile (replacing "Clocking" when a session is open) make the pending feedback clear without forcing the teacher into it immediately; (2) every `(app)` page now has a "Back" button in the header (`src/components/back-button.tsx`) — previously the only way back was clicking the "YMU-A" logo to go all the way home. Both verified live in a real browser.

> **Phase 4 is now fully verified, including the hosted parts.** A later session gained a linked Supabase MCP connection (the earlier "no link in this sandbox" blocker no longer applies) and completed everything the first pass couldn't: `npx supabase db push`-equivalent (migration `0008` applied via `apply_migration`), `npm run test:rls` (all 5 files, **60/60 passing**), and the full live acceptance cycle driven through a real browser against the real hosted project (disposable teacher/school/event, created and deleted the same way the RLS tests do): out-of-fence denial with the "move closer" message and live distance readout, in-fence clock-in recorded `on_time`, immediate non-dismissable feedback form, **logging out mid-feedback and back in re-prompts the form** (confirmed — home dashboard shows the "Feedback required" card, `/clocking` offers only the feedback form, no new clock-in possible), and submitting feedback closes the session and allows a fresh clock-in. Confirmed directly in the DB (`attendance_sessions` row: `clock_in_status='on_time'`, `clock_in_distance_m=0`, `clock_out_at` set, feedback columns populated). Note: the feedback columns checked at the time were the original invented schema (`feedback_rating` etc.), since renamed/restructured in migration `0011` — see the callout above and DECISIONS.md.
>
> **A real, unrelated security bug was found and fixed during this pass**: `0007_calendar_sync_issues.sql`'s column-level `REVOKE` on the four calendar-match columns (`google_calendar_id`, `calendar_match_source`, `calendar_match_score`, `calendar_matched_at`) never actually worked, on any environment — Postgres ignores a column-level REVOKE when the role already holds the table-wide privilege that `0005_schools.sql` grants (`grant select, insert, update on table public.schools to authenticated`). Any authenticated user could raw-`UPDATE` those columns despite `DECISIONS.md`'s stated intent. Fixed in `supabase/migrations/0009_calendar_column_revoke_fix.sql` (revoke the table-wide insert/update, re-grant explicit columns excluding the four protected ones) and confirmed via `tests/calendar-sync-rls.test.ts`'s previously-failing case now passing. See `DECISIONS.md` for the full writeup.

## Phase 4 — Clocking flow + feedback gate (built this phase)

**Migration `supabase/migrations/0008_attendance.sql`** — one table, `attendance_sessions`, and (originally) two RPCs; `clock_out_with_feedback` was later dropped and replaced by `close_session_from_zoho` (migration `0010`, then its parameters corrected in `0011` — see below). Deliberately **no separate "demand" table** (user-confirmed): an *open* session (`clock_out_at IS NULL`) IS the blocking feedback obligation. See DECISIONS.md ("The open session IS the Demand").
- `attendance_sessions` — `teacher_id`, `event_id`, `school_id`, precise `clock_in_at`, the passing GPS fix (`clock_in_lat/lng/accuracy_m`), server-computed `clock_in_distance_m`, `clock_in_status` (`on_time`|`late`), a `scheduled_start_at` snapshot (keeps status auditable if the event is later re-synced), `clock_out_at`, the feedback columns (as of `0011`: `feedback_engagement` text, `feedback_had_issue` text `'Yes'`/`'No'`, `feedback_issue_status` text nullable, `feedback_notes` text nullable, `feedback_submitted_at`), a nullable `zoho_synced_at` seam (likely vestigial now, see DECISIONS.md), and a `client_key uuid unique` idempotency key. A **partial unique index** `on (teacher_id) where clock_out_at is null` enforces at most one open session per teacher at the DB level.
- `clock_in(p_event_id, p_lat, p_lng, p_accuracy_m, p_client_key, p_grace_minutes default 5)` — verifies the caller is a matched teacher for the class, that they have **no open session** (else "submit feedback first"), that the school has coords, then re-runs the geofence check **server-side** with the existing `haversine_meters()` and rejects if `distance > geofence_radius_m` (friendly message with the metres). Computes `on_time`/`late` vs `start_at ± grace`. Idempotent on `client_key`. Returns the session row. Unchanged by the feedback rework.
- `close_session_from_zoho(p_session_id, p_engagement, p_had_issue, p_issue_status, p_notes)` (migration `0010`, replacing `clock_out_with_feedback`; parameters corrected in `0011` to match the real form — see DECISIONS.md) — the ONLY way to close a session. **Not** `SECURITY DEFINER`, **not** granted to `authenticated`/`anon` at all — only `service_role` can call it, since the caller is now the Zoho webhook route handler (no teacher JWT), not the teacher directly. Idempotent: closing an already-closed session is a no-op success (webhooks retry).
- RLS: `select` for authenticated (teacher sees own; RM by school region; OM/CPO all — same shape as `calendar_events_select`); no authenticated write grants at all. `clock_in` is the only authenticated-callable mutation; closing is service_role-only.

**`src/lib/attendance/status.ts`** — `ON_TIME_GRACE_MINUTES = 5` (single source of truth for the configurable window) + `computeClockInStatus` / `minutesLate`. TS twin of the RPC's CASE; used client-side only to *preview* status. Unit-tested in `tests/attendance-status.test.ts` (in `npm run test`).

**`src/lib/attendance/queries.ts`** — RLS-scoped server reads shared by all clock surfaces: `getOpenSession()` (the caller's open session + embedded event/school) and `getNextClass()` (soonest matched, not-ended, non-cancelled class with school coords).

**`src/components/geo-map.tsx`** — Leaflet map: school pin, teacher `CircleMarker` + accuracy halo, and the geofence `Circle` (green inside / red outside), auto-fit to frame both. Reuses the `/public/leaflet/*.png` string-URL marker pattern; loaded via `next/dynamic({ ssr:false })`.

**`src/app/(app)/clocking/`** — `page.tsx` (teacher-only): open session → renders the feedback form (clock-in not offered); else next-class card + `clocking-client.tsx`. `clocking-client.tsx` is the geolocation state machine — permission-denied / GPS-off / timeout / low-accuracy each an explicit error state with a **Try again** path, live distance readout + map, and a Clock-In form enabled only when inside the fence with a good fix. `actions.ts` → `clock_in` RPC.

**`src/app/(app)/feedback/`** (reworked — see DECISIONS.md "Phase 4 feedback rework") — `page.tsx` (teacher-only): the dedicated form route (open session → `feedback-form.tsx`; none → "nothing pending"). `feedback-form.tsx` is the shared, **non-dismissable** clock-out gate — but the form itself is now a `<iframe>` embedding a Zoho-hosted form (`src/lib/attendance/zoho-feedback.ts` builds the prefilled URL), not a native React form. There's no server action posting to an RPC anymore (`actions.ts` was deleted): the component polls `attendance_sessions.clock_out_at` every 4s to detect the Zoho webhook having closed the session, since there's no reliable cross-origin "submitted" signal from inside the iframe. Offline, it falls back to a native draft form that saves to IndexedDB via Dexie (`src/lib/attendance/offline-feedback-db.ts`) and prefills the Zoho iframe once back online. The home page (`src/app/(app)/page.tsx`) shows a prominent re-prompt card for a teacher with an open session (the login pop-up), while leaving the nav reachable — gate scope is "block clock-in only" (user-confirmed, unchanged by the rework).

**`src/app/api/zoho-feedback/route.ts`** (new) — the webhook target. Shared-secret authenticated (`x-zoho-feedback-secret` header, timing-safe compared against `ZOHO_FEEDBACK_WEBHOOK_SECRET`), validates the payload, calls `close_session_from_zoho` via a service-role client (`src/lib/supabase/admin.ts`, new — server-only, never import client-side). `src/proxy.ts`'s matcher now excludes `/api/*` entirely so this (and any future API route) isn't redirected to `/login` for its inherently-unauthenticated caller.

**`/feedback` added to `ROUTE_ROLES` (teacher-only)** in `src/lib/auth/roles.ts`, alongside `/clocking`. Unchanged by the rework.

**Post-rework UX fixes (user-requested after trying the live flow):**
- `src/app/(app)/clocking/actions.ts`'s `clockIn` action now redirects to `/` after a successful clock-in, not `/clocking`. Previously the teacher was dropped straight into the feedback form the instant they clocked in; now they land back on the dashboard, which already shows the "Feedback required" banner, and can go fill it out when ready.
- `src/app/(app)/page.tsx` — the home dashboard's nav grid now reflects an open session: the "Clocking" tile becomes **"Clock out" / "Submit feedback to finish"** instead of "Clocking" / "Next class & clock-in", still linking to `/clocking` (which shows the feedback form for an open session, unchanged).
- `src/components/back-button.tsx` (new) — a "Back" control in the `(app)` layout header (`src/app/(app)/layout.tsx`), next to the "YMU-A" logo, on every page except home. Calls `router.back()`, falling back to `/` if there's no in-app history (e.g. a direct link). Previously the only way back from any page was clicking the logo all the way home.

### Phase 4 — hosted verification (done)
1. ~~`npx supabase db push`~~ — `0008_attendance.sql` applied to `vgyogyojxlvhiwujidhy` via the Supabase MCP connection. Note: this project's tracked migration history is missing `0007` (its tables/columns exist on the live DB but the version row isn't in `supabase_migrations.schema_migrations` — it was evidently applied out-of-band in an earlier session); `0008` and `0009` (below) were applied cleanly on top regardless.
2. ~~`npm run test:rls`~~ — all 5 files, **60/60 passing** (including `tests/attendance-rls.test.ts`, 11/11).
3. ~~Run the acceptance cycle~~ — done via a real browser session against the real hosted project with a disposable teacher/school/event (cleaned up after). See the callout above for the full walkthrough and result.

---

## (Phase 3 + multi-calendar sync — retained, unchanged)

Snapshot of the repo at the end of **Phase 3 (Google Calendar sync, Schedules tab) + multi-calendar sync**, both live-verified end-to-end against the real service account, real ~72-school roster, and real 68 shared school calendars — not just mocks or dry-runs. Everything below was verified by running it: the full RLS suite, driving the real dev server as an Operations Manager and a Teacher against seeded events, and the real multi-calendar sync against production Google Calendar + Supabase data (see "Still owed" below for what's left — mostly working through the 17-item review queue and letting the initial event sync finish catching up, not code gaps).

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
