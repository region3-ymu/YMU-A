# HANDOFF — YMU-A

Final handoff at the end of **Phase 9 (Zoho reliability, school years, archiving,
error-handling, performance/PWA polish)** — the last of 10 planned phases (0–9).
This file replaces the running per-phase log with one summary of the whole build.
For exhaustive blow-by-blow detail on any phase (exact bugs found, exact
reasoning behind a schema choice), see `DECISIONS.md` — every non-obvious call
made across all 9 phases is recorded there, organized by topic, and this file
doesn't repeat it. `NEXT_STEPS.md` holds the current punch list of manual/live
steps still owed.

## What YMU-A is

A PWA for Young Musicians Unite to run teacher scheduling, GPS-verified
clock-in/out, class feedback, and attendance reporting across ~72 schools.
Roles: teacher, regional manager (RM), operations manager (OM), CPO. Next.js
16 (Turbopack) + Supabase (Postgres/Auth/RLS/Edge Functions/pg_cron) + Google
Calendar (source of schedules) + a Zoho-hosted feedback form. No native app —
installed as a PWA (Serwist service worker).

## Current deployment state

- Live at `https://ymu-a-navy.vercel.app` (Vercel).
- Hosted Supabase project: `vgyogyojxlvhiwujidhy`.
- **Migrations `0002`–`0018` are all applied and confirmed on the hosted
  project** — `0017`/`0018` (this phase) were applied by the user and
  verified directly against the live database (new columns/RPCs queried
  successfully; `npm run test:rls` passes 11/11 files, run individually —
  see "Verification" below).
- `stuck-session-detect` (the new Edge Function) is written but **not yet
  deployed or cron-scheduled** — still an owed manual step, see NEXT_STEPS.md.
- Google Calendar sync, GPS checks, notifications (Web Push + email backup),
  and reporting are all live and running on `pg_cron` (calendar-sync every 5
  min, check-closeout/late-detect/notify-dispatch every minute).
- **Zoho's feedback webhook is still not configured on Zoho's own side** — the
  single biggest open item. See "What's not done" below.

## Architecture at a glance

- **Auth/roles**: `profiles` table (teacher/regional_manager/operations_manager/cpo),
  RLS everywhere, a JWT `app_metadata.app_role` claim mirrored by trigger for
  the proxy's optimistic route gating, authoritative checks in `src/lib/auth/dal.ts`
  (`requireProfile`/`requireRole`) and in RLS itself. **Gotcha**: setting
  `profiles.role` directly (bypassing `promote_user()`) does NOT refresh the
  JWT claim — the caller must sign in again (or you must also call
  `admin.auth.admin.updateUserById(id, {app_metadata:{app_role:...}})`) or
  protected routes will bounce them home. Hit this again live while testing
  Phase 9 (see below) — it's a real, recurring trap for anyone seeding test
  accounts, not a bug.
- **Schools/schedules**: `schools` (geocoded, geofenced), `calendar_events`
  (synced from Google Calendar, teacher_ids array + fuzzy/manual school match).
  No native "create a class" UI — schedules come exclusively from Google
  Calendar.
- **Attendance**: `attendance_sessions` — an *open* session (`clock_out_at
  is null`) IS the blocking "submit feedback" obligation, not a separate
  demand table. `clock_in()` re-validates the geofence server-side always.
  `gps_checks` (5 post-clock-in samples) + `flags` (manager escalations:
  `gps_out_of_fence`, `late_clock_in`, and now `feedback_stuck`).
- **Feedback**: lives on **Zoho**, not in the app. A fixed Zoho form URL is
  embedded via iframe; Zoho's own webhook (`POST /api/zoho-feedback`) is what
  actually closes a session, via the service-role-only `close_session_from_zoho()`
  RPC. The app never renders its own feedback form fields.
- **Notifications**: `notification_queue` (generic type+payload+status),
  drained by `notify-dispatch` (Web Push primary, Resend email backup, capped
  retries).
- **Offline**: Dexie-backed queue for clock-ins/GPS samples only (not
  feedback — Zoho's webhook is the only thing that can close a session),
  replayed through `POST /api/sync` using the same RPCs as the online path.
- **Reports**: one view (`attendance_period_rows`) + one RPC
  (`report_teacher_roster`), all weekly/monthly/quarterly bucketing done in
  TypeScript (`src/lib/reports/aggregate.ts`) over raw rows, not in SQL.
- **Conventions to preserve**: one `lib/<feature>/` directory per feature area;
  server actions return `{error?, success?}` via `useActionState`, errors
  rendered as `<p role="alert" className="text-red-600 dark:text-red-400">`;
  every mutation-bearing RPC is either `security definer` with explicit
  role/ownership checks or `service_role`-only, never a raw client write path;
  every migration gets an RLS test in `tests/*-rls.test.ts` run against the
  **hosted** project (no local Docker stack) via disposable service-role-created
  users, cleaned up in `afterAll`.

## Phase-by-phase summary

**Phase 1 — Auth & RBAC.** `profiles` + role/region enums, signup trigger,
JWT `app_metadata.app_role` mirroring, `promote_user()` RPC, archived-account
login gate (`/auth/signout?error=archived`).

**Phase 2 — Schools, regions, Lists.** `schools` (geocoded via Census→Nominatim
fallback, region OM/CPO-only and immutable to RMs once set via a protect
trigger), `school_years` (scaffolded, unused until this phase), `teacher_directory()`
RPC, the Lists tab (map pins, contact info, region assignment).

**Phase 3 — Google Calendar sync + Schedules.** Dependency-free isomorphic
Google client (WebCrypto + fetch, service-account JWT auth), `calendar-sync`
Edge Function + local runner, fuzzy Location→school matching (pg_trgm),
`calendar_events`/`calendar_sync_state`/`notification_queue`, the Schedules
tab. Multi-calendar sync extension: discovery/matching for 30–70
per-school calendars (`calendar_sync_issues` review queue, pin-then-skip,
a sync lease table). Live-verified against the real service account and
real ~72-school roster; four real bugs found and fixed (calendarList vs ACL
discoverability, an insufficient OAuth scope, stale orphaned issue rows,
duplicate-named calendars stealing each other's pin). Final state: 50/68
calendars auto-matched, 17 still open in the review queue, 1 dismissed.

**Phase 4 — Clocking + feedback gate.** `attendance_sessions`, `clock_in()`
(server-side geofence re-check, on_time/late), the Clocking/Feedback tabs.
**Reworked mid-phase**: the feedback form was originally built in-app with an
invented schema, then discovered to actually live on Zoho with different real
fields — rebuilt as an iframe embed + inbound webhook (`close_session_from_zoho()`,
`/api/zoho-feedback`). This rework is the reason Phase 9's original "push
feedback to Zoho" brief became obsolete (see Phase 9 below). A real,
unrelated security bug was found and fixed in this pass too: a column-level
REVOKE on four calendar-match columns never actually worked (Postgres
ignores it when the role already holds a table-wide grant) — fixed in
`0009_calendar_column_revoke_fix.sql`.

**Phase 5 — GPS checks & late escalation.** `gps_checks` (5 samples/clock-in),
`flags` (manager-only escalations), `check-closeout`/`late-detect` Edge
Functions on 1-minute crons, the `/flags` two-tap-to-call UI.

**Phase 6 — Offline mode & sync.** Dexie queue for clock-ins + GPS samples
(deliberately not feedback), `POST /api/sync` replaying through the same
RPCs as online, exactly-once via `client_key` idempotency, an offline/pending
badge in the header.

**Phase 7 — Notifications.** Web Push (+ iOS home-screen onboarding),
`notify-dispatch` Edge Function (push primary, Resend email backup, capped
retries/day), per-type Settings with a "Responsibility Check" double-confirm
before disabling anything, dark mode (device-local toggle). A real bug found
post-launch: `push_subscriptions` was missing an `UPDATE` grant, breaking
re-subscription — fixed in `0015_push_subscriptions_grant_fix.sql`.

**Phase 8 — Reports, dashboard, exports.** `attendance_period_rows` view +
`report_teacher_roster()` RPC, weekly/monthly/9-week-quarter bucketing in
TypeScript, CSV (server) + PDF (client, `@react-pdf/renderer`) export, the
Manager Dashboard, global search. A real bug found pre-ship: the CSV export
flattened every section's rows before bucketing, double-counting the master
report's combined section against its per-teacher sections — fixed by
bucketing each section independently.

**Phase 9 — Zoho reliability, school years, archiving, polish (this phase).**
See below.

## Phase 9 in detail

**The original brief was wrong, by design of an earlier pivot — confirmed
with the user before building anything.** Phase 9 was scoped as "push stored
feedback answers to Zoho via API, with a retry queue and `zoho_synced_at`
tracking." Phase 4's rework already made Zoho the *source* of feedback, not
a destination — there's nothing in the app to push out. `ZOHO_CLIENT_ID`/
`SECRET`/`REFRESH_TOKEN` (never-used env vars from the original plan) have
been removed from `.env.example`. What actually got built instead:

1. **Zoho webhook reliability** (the real, still-unsolved problem: a session
   left open forever if Zoho's webhook never fires):
   - `detect_stuck_feedback_sessions(p_stuck_after_hours default 6)` — flags
     any `attendance_sessions` row open past the threshold, service-role
     only, idempotent per session (partial unique index), modeled on
     `detect_late_clockins()`.
   - `admin_close_stuck_session(p_session_id, p_reason)` — OM/CPO-only
     manual fallback that force-closes a session (leaves every `feedback_*`
     column null — it's an unblock, not a stand-in for real answers),
     resolves the associated flag, and stamps `admin_closed_at`/
     `admin_closed_by`/`admin_closed_reason` (new columns) rather than
     `zoho_synced_at`.
   - `zoho_synced_at` **repurposed**: now set only when `close_session_from_zoho()`
     (the real webhook path) closes a session — a clean audit signal
     distinguishing "Zoho actually closed this" from "an admin forced it
     shut," at zero migration cost since the column already existed.
   - A new `feedback_stuck` flag type surfaces on `/flags` (a
     `StuckFeedbackCard` + `ForceCloseForm`) and on the Manager Dashboard.
   - `supabase/functions/stuck-session-detect/` — written, mirrors
     `late-detect`'s shape exactly. **Not yet deployed or cron-scheduled**
     (needs Supabase dashboard/CLI access this sandbox doesn't have).
   - `clock_in()` gained a defense-in-depth check rejecting an archived
     caller directly (closes a real gap: `/api/sync`'s offline-replay path
     only checked for a valid session cookie, never `archived_at`).
   - Migration: `supabase/migrations/0017_archived_defense_and_stuck_sessions.sql`.

2. **School-year lifecycle** — confirmed with the user: **no stored FK, no
   manual "active year" selection.** A date's school year is derived purely
   by range lookup against `school_years` (`src/lib/school-years/derive.ts`,
   `findSchoolYearForDate`/`getActiveSchoolYear`), reusing/generalizing the
   lookup `src/lib/reports/aggregate.ts` already had for quarterly bucketing.
   "Active year" = whichever non-archived row's range contains today.
   New OM/CPO-only admin UI at `/lists/school-years` (create + archive; no
   new RPC needed — the table's existing RLS already permitted this, just no
   UI existed). **Hosted `school_years` still has 0 rows** — nobody has
   created one yet; do this via the new UI once logged in as OM/CPO.
   Confirmed via tests that archiving a year doesn't affect report bucketing
   for it (reports already query by date range, not by the `archived` flag).

3. **Teacher archiving** — the actual archive/unarchive *action* didn't exist
   before this phase (only the read-side: login gate, badge, report
   exclusion). Added `archiveTeacher`/`unarchiveTeacher` server actions in
   `src/app/(app)/users/actions.ts` (OM/CPO only, refuses self/CPO targets —
   mirrors the existing `assignableRoles` gate) + an `ArchiveButton` next to
   the existing badge on `/users`. No new RPC — `profiles.archived_at` was
   already writable by OM/CPO directly. Verified: calendar sync's
   teacher-matching already excluded archived profiles (Phase 3 built that
   correctly ahead of time); `clock_in()`'s new archived check above closes
   the one remaining gap (offline-replay bypass).

4. **Two authenticated-visibility gaps closed** (migration
   `supabase/migrations/0018_calendar_and_notification_visibility.sql`):
   `calendar_sync_state` and `notification_queue` had real failure state
   written to them since Phase 3/7 but **zero** authenticated grant, so no
   manager could ever see a sync failure or a notification that gave up
   retrying. Added manager-scoped `select` grants + RLS; new Dashboard
   widgets surface both.

5. **PRD §14 error-handling audit** — read every one of the six required
   categories against actual code, not assumption:

   | Category | Gap found | Fix |
   |---|---|---|
   | Google Calendar sync errors | `calendar_sync_state` written on every failure but had zero authenticated grant — invisible to managers | Migration `0018` grants + RLS; dashboard widget |
   | Zoho form failures | No detection of a webhook that never arrives, no recourse | Item 1 above |
   | GPS failures | Already best-in-class (`describeGeoError`) | No change |
   | DB connection errors | No error boundary anywhere in `(app)` | New `src/app/(app)/error.tsx`/`not-found.tsx` |
   | Notification failures | `notification_queue` marks rows failed but had zero authenticated grant | Migration `0018` grants + RLS; dashboard widget |
   | Connectivity issues | Already well-handled | Only the archived-bypass fix above applies |

6. **Performance/PWA polish**:
   - Found and fixed a real bundle-size issue: `report-view.tsx` statically
     imported `@react-pdf/renderer` (~1.4MB with its `yoga` layout
     dependency), shipping it to every `/reports` page load whether or not
     anyone clicked "Download PDF." Changed to a dynamic `import()` inside
     the click handler — confirmed via a clean rebuild that the chunk no
     longer appears in `/reports`' build manifest.
   - `leaflet`/`react-leaflet` were already dynamically imported (an earlier
     phase's work) — nothing to fix there.
   - Dark-mode sweep: audited every page lacking a `dark:` class and every
     solid saturated color usage app-wide. Conclusion: the app already
     handles this correctly everywhere via CSS-variable-backed
     `border-foreground/10`/`opacity-*` utilities (theme-safe by
     construction) and pairs every literal `text-{color}-600` with a
     `dark:text-{color}-400` counterpart with no exceptions. Verified live in
     the browser (see below) in both themes — no genuine bug found. Role
     colors: none exist; explicitly skipped as non-required polish.
   - `npm run build` clean; this Next.js version's build output doesn't print
     a per-route size table (see `AGENTS.md`'s "not the Next.js you know"
     warning) — bundle size was instead confirmed by inspecting
     `.next/static/chunks` directly before/after the react-pdf fix.
   - **Lighthouse itself was not run** — this sandbox has no `npx lighthouse`/
     Chrome DevTools access beyond the preview browser tooling used for the
     screenshots below. This is a real "done when" gap — see NEXT_STEPS.md.

### Verification actually performed this phase

- `npm run lint` / `npm run build` / `npm run test` (49 tests across 6 files,
  all pass) — clean.
- **Migrations `0017`/`0018` applied to the hosted project** (by the user,
  via a cached Supabase CLI + the session's Supabase MCP access token — this
  sandbox has no network access to the npm registry or Supabase's own
  management API, confirmed via TLS-level diagnostics, so a fresh
  `npx supabase` install/login could never have worked here; a previously-
  cached CLI binary from an earlier session made a direct, explicitly
  user-approved `db push` possible instead of pure dashboard/SQL-editor
  copy-paste). Confirmed directly: the new columns
  (`admin_closed_at`/`admin_closed_by`/`admin_closed_reason` on
  `attendance_sessions`) and RPCs (`detect_stuck_feedback_sessions`,
  `admin_close_stuck_session`) all exist and work against the live database.
- `npm run test:rls` — **all 11 files pass, run individually** (a full-batch
  run still hits Supabase's own auth rate limit when ~9+ files' worth of
  disposable users sign in back-to-back in one process — a **pre-existing,
  documented** environment characteristic since Phase 5, unrelated to Phase
  9). Two real, incidental fixes made while re-verifying against the now-live
  schema:
  - A **test-ordering bug in my own new `tests/attendance-rls.test.ts` case**:
    it assumed `teacherB` had no open session, but an earlier test in the
    same file had already clocked them in and never closed it out. Fixed by
    reusing that already-open session instead of clocking in again.
  - **Two pre-existing, Phase-9-unrelated test issues in
    `tests/events-rls.test.ts`**, surfaced only because this project's real
    hosted `calendar_events` table has grown past 1000 rows since that test
    was written: an unfiltered `select()` + `arrayContaining()` check now
    flakes because the seeded rows can fall outside PostgREST's default
    page — fixed by filtering the query to the seeded ids. Its
    `notification_queue has no authenticated read access` assertion is now
    **intentionally false** per this phase's `0018` migration — updated to
    assert the opposite (a teacher can read their own rows), without
    asserting a specific row count (this hosted project runs live cron jobs
    that can enqueue a real reminder for the test's seeded event
    mid-test-run — a genuine live-database race, not a bug).
  - New files `tests/school-years-aggregate.test.ts`, `tests/flags-rls.test.ts`,
    `tests/users-archive-rls.test.ts` all pass; `tests/schools-rls.test.ts`'s
    new school-year-archive case passes.
- **The real known stuck test session is now flagged**:
  `detect_stuck_feedback_sessions()` was run for real against the live
  database and correctly flagged `f8e52696-2000-41dd-972c-808ac51ffae8`
  (open since 2026-07-20) as `feedback_stuck` — visible now at `/flags` for
  an OM/CPO to force-close. This is the exact real-world problem this
  phase's reliability work was built to solve, confirmed working end to end.
- **Live browser verification** (real hosted DB, a disposable OM account
  created via the service-role admin API and deleted afterward): logged in,
  visited `/lists/school-years` (empty state renders correctly, real "72
  schools" data on `/lists` confirms this is the real hosted project not a
  mock), `/users` (new Archive/Unarchive buttons render correctly next to
  real teacher/RM rows, correctly absent for the caller's own row and the
  CPO row), `/flags` (renders with the updated copy, no crash from the new
  `feedback_stuck` type/column additions), `/dashboard` (all three new
  widgets — stuck feedback sessions, calendar sync, 24h notification
  failures — render correctly with real live counts). Checked both dark and
  light `preview_resize` color schemes on `/dashboard` and
  `/lists/school-years` — both clean.
- **A real, pre-existing (not Phase-9-caused) issue was hit while testing**:
  submitting any Server Action form (confirmed on both a brand-new Phase 9
  form and the pre-existing, previously-verified-working "Add school" form)
  redirected to `/login` with `Invalid Refresh Token: Refresh Token Not
  Found` in server logs, immediately after a fresh login. Reproduces
  identically on unmodified code, so it's specific to this session's
  browser-automation/cookie handling, not an app bug — but flagging it here
  in case a future session needs to actually exercise a full authenticated
  form submission live and hits the same wall. GET-based navigation and
  direct-RPC calls (via the automated RLS tests) both work fine and were
  used instead to verify the underlying logic end-to-end.

## Update-prompt reload race fixed + calendar-sync secret was never generated + stale flag cleanup

Three more live-testing rounds:

1. **`sw-update-prompt.tsx` had a real race**: `applyUpdate()` called
   `serwist.messageSkipWaiting()` and `window.location.reload()` back to back,
   without waiting for the new worker to actually take control. A real device
   got stuck on a dead/blank page after tapping "Actualizar" — confirmed the
   server itself was fully healthy (Vercel/serwist/manifest all `200`) before
   concluding this was a client-side race, not an outage. Fixed: the reload
   now happens inside the `controlling` event handler (which fires once the
   new worker genuinely has control), with a 4s safety-net timeout in case
   the event never fires. Button also shows "Actualizando…" and disables
   itself during the transition.
2. **`CALENDAR_SYNC_SECRET` had never actually been generated anywhere** —
   not in `.env.local`, and the user confirmed it wasn't visible in the
   Supabase Edge Function secrets list either. This is the real reason the
   5-min cron's calls were 401ing the whole time (spotted by correlating a
   lone 401 in `net._http_response` against the exact 5-minute-mark
   timestamps where `calendar-sync` should fire alongside the three 1-minute
   jobs). A new secret was generated and the user is setting it consistently
   in the three places it must match: the Edge Function secret, the
   Supabase Vault secret (`calendar_sync_secret`, read by the cron's
   `net.http_post` call), and Vercel (needed by the manual sync button).
3. **The known old stuck-feedback flag (`f8e52696`) was confirmed to be a
   stale leftover, not a new bug**: its session actually closed via Zoho on
   2026-07-23, but *before* migration `0021`'s auto-resolve fix existed, so
   the flag was never cleared. A one-time cleanup query (resolve any
   `feedback_stuck` flag whose session is already closed) is in
   NEXT_STEPS.md — going forward, `0021` handles this automatically for any
   new session.

Also confirmed live: the direct-to-Apps-Script test (bypassing Zoho entirely,
posting straight to the `.../exec` URL with `session_id`/`teacher_id` in the
body) successfully closed a real session end-to-end — proving the Apps
Script relay code and `/api/zoho-feedback` are both correct. The only real
gap was Zoho's own Payload Parameters never including `session_id`/
`teacher_id` (found and fixed by the user) — once that's confirmed working
live, the whole Zoho chain is done.

## Manual "Sync calendars" button + two more live-testing findings

User-requested: a way to trigger Google Calendar sync from the app (RM/OM/CPO,
via `/lists/calendar-sync`, linked from `/lists`) instead of the terminal or
waiting for the 5-min cron — select specific schools or leave all unchecked
to sync everything. `syncAllCalendars()` gained an optional `schoolIds`
filter; the Edge Function reads it from an optional request body; pg_cron's
empty body is unaffected. **Owed: set `CALENDAR_SYNC_SECRET` on Vercel**
(server-only) — the button's server action calls the Edge Function the same
way pg_cron does and needs its own copy of that secret.

Two more findings while investigating why a manually-added calendar event
wasn't showing up: (1) `matchedTeacherIds()` matches by attendee email only,
never checking `responseStatus` — an unaccepted/declined invite still gets a
teacher matched and able to clock in (confirmed by reading the code). (2) The
cron **was** firing every 5 minutes and `succeeded` per `cron.job_run_details`
— but that only proves the async `net.http_post` call was queued, not that
the Edge Function returned 200. `net._http_response` is the real signal; see
NEXT_STEPS.md.

Also: the Zoho setup section of NEXT_STEPS.md was fully rewritten — the real
form is "YMU Teacher Feedback" (not the old guessed `zfrmz.com` URL), and the
real architecture relays through a pre-existing Google Apps Script (which
mirrors submissions to a spreadsheet) rather than pointing Zoho directly at
our webhook, since Zoho Forms only supports one webhook target per form. A
real Apps Script deployment-versioning gotcha was hit live: editing the code
and clicking "Deploy" can silently create a **new** deployment URL rather
than updating the existing one, leaving Zoho still calling old code
indefinitely — see NEXT_STEPS.md for the exact check.

`npm run lint`/`build`/`test` clean; the new page was visually verified
logged in as `rm@ymu.test` against the real hosted project.

## Migration `0021` — live-testing report/flag/directory fixes (applied)

Three more issues surfaced while the user exercised the deployed app:
1. **Report "hours worked" was `clock_out - clock_in`**, so a late clock-out
   inflated the number (5h shown for a 1h class). `attendance_period_rows`
   now credits the **scheduled class duration** (`end_at - start_at`) once the
   teacher clocked in — the fixed class block, per the user's rule. Fixes both
   the Reports UI and the CSV export (shared view/aggregate).
2. **A `feedback_stuck` flag lingered on `/flags` after Zoho legitimately
   closed the session** — `close_session_from_zoho()` closed the session but
   never resolved the escalation (only `admin_close_stuck_session` did both).
   It now resolves the open flag too (system auto-resolution, `resolved_by`
   null + a note).
3. **`/lists` always showed teachers as "No region"** — `teacher_directory()`
   returned `profiles.region`, null-by-design for teachers. It now returns
   `regions text[]` derived from the schools they're scheduled at (a teacher
   can be in several), same basis as the RM-visibility scoping.
   `lists/types.ts` + `teacher-popover.tsx` updated.

Still-open (likely stale-cache, not code): `/lists` phone blank + Reports
individual-teacher picker empty for an RM. `teacher_directory` already returns
phone and `report_teacher_roster` scopes RMs by schools.region since `0020`
(and the RM now sees teachers in `/lists`, proving `0020` is live) — so these
point at the same stale service-worker bundle the "Actualizar" prompt now
handles, or teachers with no phone on file. SQL to confirm is in NEXT_STEPS.
`npm run lint`/`build`/`test` clean. **`0021` was applied by the user** (along
with scheduling the calendar-sync cron and wiring the Zoho form + Apps Script
relay) — end-to-end confirmation of each is the current owed work; see
NEXT_STEPS.md's "Verification checklist" at the top.

## Live production testing pass (migration `0020` + config gaps found)

The user tested the deployed app end-to-end (`https://ymu-a-navy.vercel.app`)
and found: (1) several env vars were never copied from `.env.local` to
production (VAPID keys, `ZOHO_FEEDBACK_FORM_URL`) — pure configuration, see
NEXT_STEPS.md; (2) the Supabase Auth "Site URL" is still `localhost` —
config-only, `emailRedirectTo` is already built correctly from the request
origin in code; (3) **a real bug**: Regional Managers saw "Unknown teacher"
on the dashboard for a correctly-assigned teacher.

Root cause: `profiles.region` is null-by-design for teachers (Phase 3
derives a teacher's region from their scheduled schools instead), but
`profiles_select` RLS still gates a Regional Manager's visibility of any
`profiles` row on `region = current_app_region()`. Every read resolving a
teacher's name/phone for an RM via a plain `profiles` select/embed — the
dashboard (2 widgets), `/flags` (breaking the "call the teacher" button —
the most consequential instance), `reports/search.ts`, and `/lists`'
`teacher_directory()` (silently empty for every RM, never reported since an
empty list looks like "no teachers yet") — silently got nothing back.
`report_teacher_roster()` (Phase 8) already had this right, scoping via
`calendar_events -> schools.region` instead. Migration `0020` extends it
with `phone` and fixes `teacher_directory()`'s scoping the same way; the 4
TS call sites now resolve names/phones through it instead of the broken
embeds. `tests/schools-rls.test.ts`'s fixture (which set `profiles.region`
directly — unrealistic vs. production) was updated to seed a school +
calendar event per region instead, matching reality.

Also added: a universal "Install app" prompt
(`src/components/install-prompt.tsx`, mounted in the root layout) — nothing
offered this before; Android only showed the browser's own easy-to-miss
native prompt, and iOS Safari never fires one at all.

**Follow-up round (stale-cache + iOS push + update prompt):** live testing
showed "missing VAPID key" persisting even after the env var was set and
deployed. Root-caused conclusively — fetched the live production JS chunks
directly and the VAPID key IS inlined there (Vercel is correct); the failures
were **stale Serwist service-worker precache** on devices that had loaded the
app before the var existed (the tester's cached Chrome failed, a fresh Firefox
worked). Shipped `src/components/sw-update-prompt.tsx` (mounted inside
`SerwistProvider`): forces `serwist.update()` on mount/interval/focus and
shows a "new version — Actualizar" banner that reloads into fresh assets, so
users self-update instead of manually clearing cache. Also fixed a real iOS
bug in `getPushSupportState()` (`src/lib/push.ts`): it checked for
`PushManager` before the iOS-installed check, so iPhone Safari users got a
dead-end "not supported" instead of the "add to Home Screen first" onboarding
(iOS only exposes push to an installed PWA). The Zoho "not configured" report
is the same stale-cache story plus a reminder that `ZOHO_FEEDBACK_FORM_URL` is
a server-side (non-`NEXT_PUBLIC_`) Vercel var needing Production scope + a
redeploy — it does not belong in Supabase. `lint`/`build` clean.

`npm run lint`/`build`/`test`/`tsc --noEmit` all clean. **Migration `0020`
is applied** (user confirmed against the hosted project).

**One more finding from this same live-testing pass, unrelated to `0020`:**
querying `cron.job` on the hosted project showed only
`check-closeout-1min`/`late-detect-1min`/`notify-dispatch-1min` — **no
`calendar-sync` job has ever been scheduled**, despite this file's own
Phase 3 notes claiming it was live. `calendar_sync_state.last_synced_at`
had been stuck for 3 days as a direct result — this is the actual reason a
Regional Manager saw an empty `/schedules` for a real school with real past
classes: nothing had synced in days, so no upcoming events existed to show.
Not a code bug; the fix is scheduling the missing `cron.job` entry (same
`net.http_post` + Vault-secret pattern as the other three), given directly
to the user. **Confirm it's scheduled and firing before assuming this is
resolved** — see NEXT_STEPS.md for the exact SQL.

## Post-Phase-9 hardening pass (security/reliability review, migration `0019`)

A full-app security/code review (not a new feature phase) found no critical
vulnerabilities — every mutation already ran through a `SECURITY DEFINER` RPC
or a `service_role`-only path, RLS was on every table, and authz was already
three-layered (proxy → DAL → RLS). What it found was low-severity/reliability
work, all fixed in one pass:

1. **`supabase/config.toml`** now has `verify_jwt = false` blocks for all four
   remaining scheduled functions (`check-closeout`/`late-detect`/
   `notify-dispatch`/`stuck-session-detect`) — previously only `calendar-sync`
   had one, so a redeploy of the other four would have silently defaulted them
   to `verify_jwt = true` and the gateway would reject every cron call before
   the function's own secret check ever ran. Also tightened
   `minimum_password_length` (6→8) and `enable_confirmations` (false→true) to
   match what the app already assumes — **this file is the local dev config**;
   confirm the hosted dashboard's own auth settings match separately.
2. **`notify-dispatch` duplicate-send fix**: a new `claim_notification_batch()`
   RPC (migration `0019`) atomically leases a batch via `FOR UPDATE SKIP
   LOCKED` with a `claimed_at` reclaim window, replacing the plain `select`
   that let an overrunning run's next tick re-send the same rows.
3. **`close_session_from_zoho()` teacher-ownership check** (migration `0019`):
   takes an optional `p_teacher_id` and rejects a mismatch — closes the gap
   where a teacher could edit the Zoho form's prefilled `session_id` to target
   another teacher's open session. Backward-compatible (the check only
   enforces once the real Zoho form gains a hidden `teacher_id` field — see
   NEXT_STEPS.md); the app-side plumbing (config, URL builder, both callers,
   the webhook route) is already in place and ready for it.
4. **Constant-time secret compares**: `supabase/functions/_shared/secret.ts`
   centralizes a SHA-256-then-compare helper, used by all five scheduled
   functions instead of each doing its own `!==` (a gratuitous timing
   side-channel; the Zoho webhook route already did this correctly).
5. **`notification_queue_select` now region-scopes Regional Managers**
   (migration `0019`) — `0018` gave any manager all rows since the table has
   no `school_id` column to filter on directly; this reads `payload ->>
   'school_id'` and joins to `schools.region`, matching how `flags`/`gps_checks`
   already scope RMs.
6. **`searchAllAction` now calls `requireProfile()`** — it was the one query
   entry point relying on RLS/proxy alone with no explicit server-side
   identity check.
7. **`SITE_URL` env var** replaces a hardcoded production URL in
   `notify-dispatch`'s email body.
8. **`scripts/seed-test-data.ts`** (`npm run seed:test`, gated behind
   `SEED_ALLOW=1`): bootstraps one account per role (writing `profiles.role`
   **and** the JWT claim together, so the well-known re-login trap never
   bites), a geofenced test school, the first `school_years` row, and a
   calendar event the seeded teacher can clock into — the whole manual test
   setup in one idempotent command.

New RLS tests: `tests/zoho-ownership-rls.test.ts`,
`tests/notify-scope-rls.test.ts` (both added to `test:rls`, now 13 files).
`npm run lint`/`build`/`test` all clean. **Migration `0019` is applied**
(user confirmed). **The 4 Edge Function redeploys are not confirmed done**
— this sandbox has no path to do that itself (see "What's not done"
below); the code is written and tested, the actual `supabase functions
deploy` for each is on the user.

## What's not done (owed, documented, not a code gap)

See `NEXT_STEPS.md` for the full punch list with exact commands. Summary:

0. **Apply migration `0019`** and **redeploy the 4 scheduled Edge Functions**
   (they now import the new `_shared/secret.ts`; `notify-dispatch` also needs
   `SITE_URL` set as an Edge secret) — the hardening pass above is written and
   unit/lint/build-clean but not yet live on the hosted project.
1. **Deploy `stuck-session-detect` and cron-schedule it** (every ~15 min,
   given the multi-hour threshold). Not yet attempted this session beyond
   the migration push above.
2. **Configure Zoho's webhook on Zoho's own side** — still nobody has done
   this (user lacks Zoho account access). Exact steps unchanged from the
   last several phases' notes, in NEXT_STEPS.md. Also add a hidden
   `teacher_id` field to the real form (alongside `session_id`) so the new
   ownership check in item 3 above actually enforces.
3. **Force-close the known stuck session** (`f8e52696-2000-41dd-972c-808ac51ffae8`,
   now flagged and ready) via the new `/flags` UI.
4. **Create the first real `school_years` row** via the new `/lists/school-years`
   UI — the table has been empty since Phase 2. `npm run seed:test` also
   creates one.
5. **Run a real Lighthouse pass** against mobile viewports for the PWA/perf
   "done when" criteria.
6. Everything already flagged as owed by earlier phases and never
   resolved (Resend domain verification, a live-device push/offline
   walkthrough, the 17-item multi-calendar review queue) — still owed,
   unchanged by this phase.

## How to verify the current state yourself

```bash
npm install
npm run lint             # clean
npm run build             # clean; compiles all routes including /lists/school-years
npm run test               # 49 credential-free unit tests, no Supabase needed
npm run test:rls           # hosted-project RLS suites (needs .env.local's Supabase keys);
                            # run files individually to avoid the auth rate limit noted above —
                            # e.g. npx vitest run tests/flags-rls.test.ts
                            # now 13 files: adds tests/zoho-ownership-rls.test.ts and
                            # tests/notify-scope-rls.test.ts (the hardening pass above)
SEED_ALLOW=1 npm run seed:test   # one-command QA bootstrap: one account per role
                                  # (teacher@/rm@/om@/cpo@ymu.test), a geofenced test
                                  # school, a school year, a clock-in-able event
```

For a full live walkthrough now that `0017`/`0018` are applied: log in as OM/CPO,
create a school year at `/lists/school-years`, archive a teacher at `/users`,
force-close the known stuck session at `/flags`, and check the Manager
Dashboard's three new widgets reflect real state. Once migration `0019` is
applied and the 4 functions redeployed, `npm run seed:test` gets you logged-in
test accounts for every role in one step instead of that manual setup.
