# NEXT_STEPS — YMU-A

Where to pick up. **Phase 9 (Zoho reliability, school years, archiving,
error-handling, performance/PWA polish) is code-complete AND migrations
`0017`/`0018` are now applied to the hosted project** — see HANDOFF.md for
the full description. Everything below "Finish Phase 9" is prior-phase
history, kept for reference; the actionable work right now is the short
Phase 9 list immediately below.

## 🔴 Finish Phase 9 — deploy the new Edge Function, configure Zoho, run Lighthouse

1. ~~Apply migrations `0017` and `0018`~~ — **done.** Applied to the hosted
   project (`vgyogyojxlvhiwujidhy`) via a cached Supabase CLI + the session's
   configured access token. Confirmed directly (new columns/RPCs queried
   successfully) and via `npm run test:rls` (all 11 files pass, run
   individually to avoid the pre-existing multi-suite auth rate limit).
   `detect_stuck_feedback_sessions()` was run for real and correctly flagged
   the known stuck session (see item 3 below).
2. **Deploy `supabase/functions/stuck-session-detect/`** (mirrors
   `late-detect`'s shape exactly) and schedule it, e.g. every 15 minutes
   given the multi-hour threshold — **not yet done**:
   ```sql
   select cron.schedule('stuck-session-detect-15min', '*/15 * * * *', $$
     select net.http_post(
       url := 'https://vgyogyojxlvhiwujidhy.supabase.co/functions/v1/stuck-session-detect',
       headers := jsonb_build_object('Content-Type','application/json',
                                      'x-stuck-session-detect-secret', (select decrypted_secret from vault.decrypted_secrets where name='stuck_session_detect_secret')),
       body := '{}'::jsonb
     );
   $$);
   ```
   Set `STUCK_SESSION_DETECT_SECRET` as both an Edge Function secret and a
   Supabase Vault secret (same pattern as `check-closeout`/`late-detect`).
3. **Force-close the known stuck test session** at `/flags` —
   `f8e52696-2000-41dd-972c-808ac51ffae8` (open since 2026-07-20) is **now
   flagged `feedback_stuck`**, confirmed live. Log in as OM/CPO, go to
   `/flags`, and force-close it with a reason — this both exercises the new
   feature for real and clears the leftover data.
4. **Create the first real `school_years` row** at `/lists/school-years`
   (new UI, OM/CPO only) — e.g. name `2026-2027`, start `2026-08-10`, end
   `2027-06-04`. The table has been empty since Phase 2; quarterly reports
   fall back to "No school year" until this exists. No code change needed
   once it does.
5. **Configure Zoho's webhook on Zoho's own side** — still not done, still
   blocked on Zoho account access. See "Finish the Zoho feedback setup"
   further below for the exact steps (unchanged since Phase 4/6).
6. **Run a real Lighthouse pass** (mobile viewport, `/clocking`/`/dashboard`/`/`)
   for the PWA/performance "done when" — not run in this sandbox (no
   `npx lighthouse`/DevTools access beyond the preview browser tooling used
   for screenshots).
7. A pre-existing, non-Phase-9 environment quirk was hit while verifying:
   submitting **any** Server Action form in this sandbox's browser-preview
   tooling (confirmed on both new and untouched pre-existing forms)
   redirects to `/login` with `Invalid Refresh Token: Refresh Token Not
   Found`, immediately after a fresh login. Not reproduced as a real-user
   issue in any prior phase's live verification — flagging it so a future
   session doesn't mistake it for a Phase 9 regression if it needs to
   exercise a full authenticated form submission in this same tooling.
8. This sandbox's network blocks the npm registry and Supabase's own
   management API at the network/DNS level (confirmed via TLS/DNS
   diagnostics) — a fresh `npx supabase login`/install can never work here.
   Migrations only got applied this time because a fully-cached CLI binary
   happened to be left over from an earlier session, and Claude explicitly
   asked before using it (auth + schema changes against production). Don't
   assume this shortcut will be available in a future session — the
   documented fallback (dashboard SQL editor, or the user's own machine)
   still applies.

## Things Phase 9 leaves that a later maintainer should know

- **`zoho_synced_at`'s meaning changed**: it now means "closed by the real
  Zoho webhook," set only in `close_session_from_zoho()`. A force-closed
  session (via `admin_close_stuck_session`) sets `admin_closed_at`/
  `admin_closed_by`/`admin_closed_reason` instead and leaves `zoho_synced_at`
  null — the two paths are mutually exclusive by construction. Any future
  reporting that touches "was this session closed normally" should check
  both columns, not just one.
- **School-year linkage is pure date-range lookup, no stored FK** —
  `src/lib/school-years/derive.ts` is the one place "which year does this
  date fall in" lives; `src/lib/reports/aggregate.ts` already depends on it.
  Don't add a `school_year_id` column to `calendar_events`/`attendance_sessions`
  without revisiting this decision with the user first — it was explicit.
- **`flags.type` is still a free-text column** (not an enum), now with three
  values (`gps_out_of_fence`, `late_clock_in`, `feedback_stuck`). A future
  phase adding another escalation type should follow the same pattern:
  widen the check constraint, add a partial unique index if it needs
  idempotent detection, add a card renderer on `/flags`.
- **Migration numbering**: `0018` is latest; next available is `0019`.
- **RLS tests**: `npm run test:rls` runs **eleven** files as of this phase
  (added `flags-rls.test.ts`, `users-archive-rls.test.ts`; extended
  `attendance-rls.test.ts` and `schools-rls.test.ts`). The multi-suite
  `signInWithPassword` rate-limit caveat (documented since Phase 5) still
  applies — run a new suite standalone first.
- **A real RLS-testing lesson learned this phase**: an `UPDATE` blocked by
  RLS's `USING` clause (row invisible to the caller) does **not** raise an
  error — it silently matches zero rows and returns success. Only a
  trigger-based rejection (like `protect_school_region`) or a `WITH CHECK`
  failure on `INSERT` raises a real Postgres error. Don't write a test
  asserting `error).not.toBeNull()` for an RLS-blocked `UPDATE` — assert the
  value is unchanged via a follow-up read instead (see `tests/schools-rls.test.ts`'s
  school-year archive test and `tests/users-archive-rls.test.ts` for the
  corrected pattern).
- **`notification_queue` is no longer fully blocked to authenticated users**
  (own rows + any manager, per `0018`) — `tests/events-rls.test.ts`'s old
  "no authenticated read access" assertion from Phase 3 was updated to match.
  Any future code that assumed this table was service-role-only should be
  re-checked.
- **`tests/events-rls.test.ts`'s "operations manager sees every event" test
  now filters to the seeded ids** rather than fetching the whole table —
  the real hosted `calendar_events` table has grown past PostgREST's
  default 1000-row page (1746+ real synced events). Any future RLS test
  against a table with real, growing production data should filter to its
  own seeded ids rather than asserting containment within an unfiltered
  fetch — this will only get worse as the table grows.

## Previously: Phase 8 (Reports, dashboard, exports) — fully built, migration applied, test-verified, live-verified

Attendance reporting (hours/rate/on-time/late/missed), the teacher/RM/OM-CPO
report views, CSV/PDF export, the Manager Dashboard, and cross-table search
were all working end-to-end as of Phase 8. `school_years` having zero rows
was Phase 8's one flagged operational gap — **Phase 9 built the admin UI to
fix this** (`/lists/school-years`, see above); the row itself still needs
creating.

## Things Phase 8 left that later phases should know

- **`attendance_period_rows` (view) and `report_teacher_roster()` (RPC) are the two new SQL objects** (`supabase/migrations/0016_reports.sql`). The view's authorization is hand-written in its `WHERE` clause (mirroring `attendance_sessions_select` exactly) rather than delegated to the underlying tables' RLS — necessary because it unnests `calendar_events.teacher_ids`, an array column RLS can't restrict element-by-element. **Any future view/function that unnests `teacher_ids` needs the same explicit per-row authorization check** — don't assume the underlying table's RLS is sufficient once you've unnested an array.
- **`report_teacher_roster()` is deliberately not `teacher_directory()`** (Phase 2) — the latter scopes a Regional Manager by `profiles.region`, which is stale/mostly-null since Phase 3 made a teacher's region derive from their scheduled schools instead. If a later phase needs "teachers visible to this manager" again, reuse `report_teacher_roster()`'s region-via-schools approach, not `teacher_directory()`'s.
- **Bucketing/aggregation lives entirely in TypeScript** (`lib/reports/aggregate.ts`), not SQL — weekly/monthly are UTC calendar boundaries, quarterly is a 63-day block anchored to `school_years.start_date`. If a later phase adds a new granularity or changes the on-time/late/missed/upcoming vocabulary, this is the one file to change; `attendance_period_rows`'s `attendance_status` values are the contract between SQL and TS.
- **When combining multiple teachers' rows into one total** (the master report's "combined" section, an RM's un-drilled "all teachers in region" view), always pass `combineTeachers: true` to `bucketReportRows()` — and never re-bucket a **flattened union of overlapping sections** (a real bug found and fixed during this phase's own verification, see DECISIONS.md). `buildReportSections()`'s sections overlap on purpose (the combined section contains every row that also appears in a per-teacher section); bucket each section independently, then concatenate summaries, never rows.
- **The Manager Dashboard (`app/(app)/dashboard/`) reuses existing RLS-scoped tables/views for every widget** — no new SQL besides what this phase already added for reports. A later phase adding a new dashboard widget should look for an existing scoped source first (the way "late" reuses Phase 5's `flags` table) before writing new queries.
- **Migration numbering**: `0016_reports.sql` is the latest; next available is `0017_...`.
- **RLS tests**: `npm run test:rls` runs **nine** files as of this phase (profiles, schools, events, calendar-sync-issues, attendance, gps-checks, offline-sync, notifications, reports). The multi-suite `signInWithPassword` rate-limit caveat (documented since Phase 5) still applies — run a new suite standalone first, same as every phase before this one.

## Previously: Phase 7 (Notifications) — fully built, migration applied, Edge Function deployed and cron-wired, test-verified (12/12 RLS + 11/11 unit) Web Push (via `npm:web-push`) + Resend email backup now drain `notification_queue` every minute; three new reminder types (`be_there_soon`/`clock_in_reminder`/`clock_out_reminder`) are generated automatically; Settings has dark mode, per-type on/off + adjustable lead times, and a Responsibility Check double-confirmation before disabling anything. **What's left is entirely dashboard configuration + a live-device walkthrough** — nothing code-side is outstanding. See "Finish Phase 7" immediately below.

**Phase 6 (Offline mode & sync) is fully built and applied to the hosted project, test-verified 7/7** — see HANDOFF.md for the full description (migration `0013` applied via MCP; `tests/offline-sync-rls.test.ts` 7/7; Phase 5 `gps-checks-rls` still 7/7 after the shared-helper refactor; unit 21/21; build clean). Offline clock-ins + GPS samples queue in Dexie, replay exactly-once through `POST /api/sync` on reconnect, and the dashboard shows an "Offline"/"N pending" badge. The only thing outstanding is the real **airplane-mode-on-a-device** walkthrough of the "done when" (no device/connectivity/GPS automation in this sandbox) — see "Finish Phase 6" below.

## Finish Phase 7 (Notifications) — one real blocker left, plus the live-device walkthrough

**Status as of this check** (Supabase Edge secrets, Resend, and Vercel's env var were all set by the user and then independently verified, not just taken on trust):

1. ~~Set the Edge Function secrets~~ (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`/`NOTIFY_DISPATCH_SECRET`) — **done, confirmed via `curl`**: the function no longer 500s with "not configured"; it now returns a normal result. The cron job (`notify-dispatch-1min`) is scheduled and reading `NOTIFY_DISPATCH_SECRET` correctly from Vault.
2. ~~Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in Vercel~~ — **the user reports this is done; couldn't be independently confirmed from outside** (tried fetching the live production bundle and searching for the key string; the settings page's client chunk isn't referenced plainly enough in production output to locate that way). Two things worth checking directly:
   - `NEXT_PUBLIC_*` variables are baked in at **build** time — if this was added in Vercel's dashboard but no new deployment has run since, it won't take effect until the next deploy (redeploy, or push a commit).
   - Simplest real check: open the live site's `/settings` page as a signed-in teacher and tap "Enable notifications" — if it asks for permission and doesn't error, the key is live.
3. 🔴 **Resend — set up, but blocked on domain verification.** `RESEND_API_KEY`/`RESEND_FROM_EMAIL` are both set (`emailConfigured: true` confirmed live) and `notify-dispatch` genuinely attempts a send, but the send itself fails. Confirmed directly from the Edge Function's own logs (`supabase functions logs` / the dashboard's Function Logs, or the MCP `get_logs` tool with `service: edge-function-runtime`), a real send returns:
   > `403: "The ymu.org domain is not verified. Please, add and verify your domain on https://resend.com/domains"`

   **Fix**: in the Resend dashboard, go to **Domains → Add Domain**, add `ymu.org` (or whatever domain `RESEND_FROM_EMAIL` is on), and add the DNS records (SPF/DKIM, usually a couple of `TXT`/`CNAME` records) Resend gives you at your domain registrar/DNS provider. Verification can take a few minutes to a few hours depending on DNS propagation. Until this is done, **push notifications work fully**, but schedule-change/cancellation/clock-out-reminder emails will keep failing silently (marked `email_status='failed'` in `notification_queue`, no email actually sent) — nothing else needs to change once the domain verifies; the code path is already correct and tested.

### Live-device walkthrough (the "done when" criteria)

1. **Push 15 minutes before a test event.** Install the PWA to a phone's home screen (Add to Home Screen from the browser share menu), open it from the home screen icon, go to Settings, and tap "Enable notifications" (on iOS this only appears once the app is actually running as an installed PWA — a plain Safari tab shows the "Install to Home Screen first" steps instead). Grant the permission prompt. Then seed a test `calendar_events` row with `start_at` ~16 minutes out and the test teacher in `teacher_ids`, with a matched `school_id`. Lock the phone. Within a minute of the 15-minute mark, a push notification should arrive on the lock screen ("Time to head over").
2. **Disabling requires the Responsibility Check.** In Settings, toggle any notification type off. Confirm the two-step dialog appears (a warning + Continue, then a checkbox + "Turn off") and that the toggle only actually flips after both steps — cancelling at either step leaves it on. Confirm in the DB: `select enabled from notification_preferences where user_id = '<id>' and type = '<type>';` shows `false` only after confirming.
3. **A Google Calendar edit produces both a push and a backup email.** Edit a test event's time/location on the school's real Google Calendar (or run `npm run sync:calendar` against a manually-edited `calendar_events` row), confirm a `time_changed`/`location_changed` row lands in `notification_queue`, and within a minute confirm: the subscribed device gets a push ("Schedule changed"), and the teacher's real email inbox gets a Resend email with the same information. Check `select status, email_status from notification_queue where id = '<row>';` → both `sent`.

## Phase 7 was built without the original external plan file

⚠️ Phase 7's detailed scope was originally meant to come from an external plan file (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`) that does not exist in this environment — the phase brief's own inline description was used instead, and a few genuinely ambiguous product calls (Web Push crypto approach, dark-mode persistence scope, whether clock-in/clock-out reminders get adjustable leads) were confirmed with the user directly before building (see DECISIONS.md). "Things Phase 6 leaves that Phase 7 (and later) should know" below is accurate background regardless.

## Finish Phase 6 (live-device walkthrough only)

Everything server-side is applied and test-verified; this is the one thing the sandbox couldn't exercise. On a **real phone** (or a desktop browser with DevTools → Network → Offline + a mocked geolocation), signed in as a teacher who has a matched, in-progress/upcoming class at a school with coordinates:
1. **Offline clock-in succeeds locally.** Load `/clocking` online first (so the class + school coords cache to Dexie), then turn on airplane mode / go Offline. The header shows the amber **"Offline"** badge. Tap **"Check my location"** (allow GPS), confirm you're inside the fence, then tap **"Clock in (offline)"** → it shows "Clocked in — saved offline", and the header shows **"1 pending"**.
2. **Syncs exactly once on reconnect, even if replayed twice.** Turn connectivity back on. Within a moment the "pending" chip clears. Confirm in the DB exactly one session exists: `select count(*), origin, clock_in_status from attendance_sessions where teacher_id = '<id>' and event_id = '<id>' group by origin, clock_in_status;` → one row, `origin='offline'`. To prove idempotency under forced replay, re-POST the same queued body twice (or in DevTools call `navigator.serviceWorker.controller` / just toggle offline→online again) — the count stays **1** (the `client_key` unique constraint + `clock_in`'s idempotent-replay branch guarantee it).
3. **Offline badge on the dashboard.** With airplane mode on, the home dashboard header shows the **"Offline"** badge; with a queued-but-unsynced item it also shows **"N pending"**. (Both live in the shared `(app)` layout header, so they appear on every signed-in page including `/`.)
4. **Offline GPS checks flow through.** While still offline after clocking in, keep the tab foregrounded past the +5 min mark — the sampler queues an offline GPS sample. On reconnect, confirm the corresponding `gps_checks` row flips to `verified` (in-fence) with `origin='offline'`: `select status, origin from gps_checks where session_id = '<id>' order by due_at;`.
5. **Rejected items aren't lost.** (Optional) Force a rejection — e.g. queue an offline clock-in, then cancel the event server-side before reconnecting — and confirm the item stays in the queue as `rejected` with a `last_error` (visible in IndexedDB → `ymu-a-offline` → `queue`), not silently dropped.

**Phase 4 (Clocking flow + feedback gate) is fully built and verified**, including the hosted parts — see HANDOFF.md (migration `0008` applied, `npm run test:rls` passing, live browser acceptance cycle against the real hosted project). A real, unrelated security bug in the Phase 3 calendar-match column protection was also found and fixed along the way (migration `0009`; see DECISIONS.md).

**Feedback was then reworked to a Zoho-hosted form + webhook** (product change, PRD-confirmed), corrected once to match the real Zoho form's actual fields (migration `0011`, see DECISIONS.md), and had two UX fixes land on top (redirect home instead of straight into the feedback form after clock-in, a "Back" button on every page). All of that is done from the app's side — what's left is a short list of **manual Zoho-side steps** ("Finish the Zoho feedback setup" below); none of it blocks moving on.

## 🔴 The app is now deployed, but the Zoho webhook is STILL not configured on Zoho's side (blocks every clock-out)

The app is live at **`https://ymu-a-navy.vercel.app`**. `ZOHO_FEEDBACK_FORM_URL` and `ZOHO_FEEDBACK_WEBHOOK_SECRET` are set in **Vercel → Settings → Environment Variables** (values match what's in the developer's local `.env.local`). That only prepares *our* side — nothing has been configured on **Zoho's** side yet, and the user confirmed they don't currently have access to the Zoho Forms account to do it.

**Symptom this causes**: a teacher clocks in, fills out and submits the real Zoho feedback form, and *nothing happens* — the session never closes, the "clock out" gate never clears, because Zoho never actually calls our webhook (it isn't configured to). This is not a bug in the app; confirmed live twice — once against `localhost` (where it's expected, since Zoho can't reach a local machine) and once against the Vercel deployment (where it should have worked, but the Zoho-side webhook was never set up at all — the user only touched Vercel, never opened Zoho Forms' own Integrations tab).

**Next session, as soon as there's access to the Zoho Forms account, do this** (Zoho Forms → the "TeacherFeedback" form → **Integrations → Webhooks → Configure Webhook**):
1. **Webhook URL**: `https://ymu-a-navy.vercel.app/api/zoho-feedback`
2. **Content Type**: `application/json`
3. **Custom Header**: `x-zoho-feedback-secret` = the same value stored in Vercel's `ZOHO_FEEDBACK_WEBHOOK_SECRET` (ask the person who set up Vercel for the value, or rotate it — see "Rotate note" pattern used for Phase 5's Edge Function secrets, same idea: update it in Vercel AND in Zoho's header together).
4. **Payload Parameters**: select `session_id`, `MultipleChoice` (engagement), `MultipleChoice1` (had issue), `MultipleChoice2` (issue status), `MultiLine` (notes).
5. **Verify the hidden `session_id` field actually exists on the form.** As of the last check (Phase 4 rework) it did **not** — this needs a **Hidden Field** component (not a hidden text field — Zoho has a dedicated component) with Link Name exactly `session_id`, added in the form editor and saved, before step 4 above can even select it as a payload parameter.
6. **Test it for real**: clock in as a teacher against the deployed app, submit the real Zoho form, confirm `/clocking` shows "Feedback received" within ~4s (it polls), and confirm in the DB: `select clock_out_at, feedback_engagement, origin from attendance_sessions where id = '<session_id>';` shows the row closed.

**Known currently-stuck test session** (leftover from this debugging pass, safe to leave or manually close via SQL/RPC once someone has DB access): `attendance_sessions.id = f8e52696-2000-41dd-972c-808ac51ffae8`, open since `2026-07-20 22:24:41 UTC`. It will never close on its own since no webhook can reach it retroactively — either close it manually (`update attendance_sessions set clock_out_at = now(), feedback_engagement = '...', feedback_had_issue = 'No', feedback_submitted_at = now() where id = '...'` via the service-role client, since there's no authenticated update grant) or leave it; it only blocks that one teacher from clocking into a new class until closed.

## Finish Phase 5 (one thing left)

1. ~~Deploy the two new Edge Functions~~ — done via the Supabase MCP `deploy_edge_function` tool: `check-closeout` and `late-detect` are both `ACTIVE` on the hosted project (`verify_jwt: false`, same as `calendar-sync`).
2. ~~Store the shared secrets + schedule both crons~~ — done: two random secrets were generated and stored in Supabase Vault (`check_closeout_secret`, `late_detect_secret`), and `cron.schedule('check-closeout-1min', '* * * * *', ...)` / `cron.schedule('late-detect-1min', '* * * * *', ...)` are both `active` (jobids 1 and 2), each `net.http_post`-ing the deployed function URL with the matching header, reading the secret out of Vault every run (same pattern as the calendar-sync cron SQL documented in HANDOFF.md).
3. ~~Set the two Edge Function secrets in the dashboard~~ — done by the user (Project Settings → Edge Functions → Secrets, values matching the Vault-stored ones). Confirmed working end-to-end via `curl` (both functions now return `200` with real RPC results, e.g. `{"closed":0}`/`{"flagged":0}`, instead of `500 "not configured"`) and via `cron.job_run_details` showing repeated `succeeded` runs on schedule for both jobs. **Rotate note**: if these secrets are ever rotated, update both the Edge secret (dashboard) and the matching Vault secret (`update vault.secrets set secret = '<new value>' where name = 'check_closeout_secret' / 'late_detect_secret'`) — the cron jobs read from Vault, so only updating the Edge secret alone would break them.
4. **Run the live "done when" walkthrough** the brief specifies, which nothing in this session could exercise (no real device/browser automation for GPS + foreground/background transitions in this sandbox):
   - A shift kept open in the foreground shows 5 in-fence checks (watch `gps_checks` rows flip from `pending` to `verified` over ~25 min, or fast-forward by backdating `due_at` via SQL as `tests/gps-checks-rls.test.ts` does).
   - Locking the phone (or just closing the tab / switching apps) produces `unverifiable` results with no flag once `close_out_overdue_gps_checks` runs.
   - A spoofed out-of-fence reading (override `navigator.geolocation.getCurrentPosition` in-page, same technique Phase 4's browser verification used) creates a flag and a queued RM `notification_queue` row, visible at `/flags` to the Regional Manager for that school's region.
   - A missed clock-in (seed a class with `start_at` 6+ minutes ago and a matched teacher, no clock-in) produces the two-step call card at `/flags` once `detect_late_clockins` runs, with working `tel:` links if the teacher/school have phone numbers on file.

Still-open pre-Phase-4 work also remains: Phase 3's multi-calendar sync review queue and the initial event-sync catch-up (below). **Multi-calendar sync is live-verified**: **50/68 calendars pinned**, **17 genuinely open** ([`calendar-sync-open-issues.csv`](calendar-sync-open-issues.csv), local artifact), 1 dismissed. Event-sync is still catching up (only ~9/50 pinned calendars had finished their initial full sync at last run) — keep running `npm run sync:calendar` or deploy the cron.

## Finish the Zoho feedback setup (two things left)

The app's schema/webhook/prefill were rebuilt to match the REAL "TeacherFeedback" form (read directly out of its live HTML, not guessed — see DECISIONS.md for the full comparison against an earlier, wrong, invented schema). The real form asks: Teacher Name (dropdown), Date, School (dropdown), Choose program (dropdown), student engagement (5-choice scale), whether there was an issue (Yes/No), issue status (conditional), and optional notes.

The real, fixed form URL (`https://zfrmz.com/MIVJGi5IlokeTf8oTsDR`, the one already embedded in every calendar event's description) is set in `ZOHO_FEEDBACK_FORM_URL`, with the real field Link Names as defaults in `zoho-feedback.ts` (`Dropdown`/`Date`/`Dropdown1`/`Dropdown2`/`MultipleChoice`/`MultipleChoice1`/`MultipleChoice2`/`MultiLine`).

1. **Add a hidden `session_id` field to the real form** (doesn't exist yet) — in Zoho Forms' editor, drag a **Hidden Field** (not a hidden text field — Zoho has a dedicated component for this) onto the "TeacherFeedback" form, set its Link Name to exactly `session_id`, save. Without this, the webhook has no reliable way to know which attendance session a submission belongs to.
2. **Configure the webhook**: Zoho Forms → Integrations → Webhooks → Configure Webhook.
   - Webhook URL: `https://<your-deployed-domain>/api/zoho-feedback`
   - Content Type: **application/json**
   - Payload Parameters: select `session_id` (the new hidden field), `MultipleChoice` (engagement), `MultipleChoice1` (had issue), `MultipleChoice2` (issue status), `MultiLine` (notes) — School/Teacher/Date/Program don't need to round-trip back, the app already knows them.
   - Custom Headers: add `x-zoho-feedback-secret` = the same value you set for `ZOHO_FEEDBACK_WEBHOOK_SECRET`
3. **Test it for real**: log in as a teacher with an open session, load `/clocking`, confirm the real form renders with School/Date/Program pre-selected (Teacher Name prefill is a best-effort — see caveat below). Fill in the rest and submit, and confirm the page updates to "Feedback received" within a few seconds (it polls every 4s). If it doesn't, check the webhook delivery log in Zoho and compare the actual payload shape against what `src/app/api/zoho-feedback/route.ts` expects — this still hasn't been tested against a real Zoho delivery, only a simulated `curl` one.
4. **Test the offline path too**: go offline (DevTools → Network → Offline) with an open session, fill and save the local draft form (engagement/issue/notes), go back online, and confirm the real form loads prefilled with those answers too.
5. ~~Decide whether the old "push feedback to Zoho via API" plan is still needed~~ — resolved in Phase 9: confirmed with the user it's not. `ZOHO_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` removed from `.env.example`. Phase 9 built inbound-webhook *reliability* instead (stuck-session detection + admin force-close) — see HANDOFF.md.

**Caveats to know about, not yet resolved:**
- **Teacher Name prefill is unreliable by design, not a bug** (user-confirmed): the real dropdown's choices are teacher full names tied to specific emails (e.g. "Jefferson Joseph" ↔ `jeffadamjoseph@gmail.com`), but the calendar event only carries the teacher's Google account email, and our own `profiles.full_name` may not exactly match the dropdown's registered spelling. If it doesn't match exactly, the dropdown just won't show anything pre-selected — the teacher picks their own name manually, which is an acceptable fallback, not a broken feature.
- **Dropdown/choice-field prefill via URL params is unconfirmed to actually apply the selection** — Zoho's own community threads note this can be unreliable for some field types. The URL the app builds is confirmed correct (checked directly: `?session_id=...&Dropdown1=<school>&Dropdown=<teacher>&Date=<dd-MMM-yyyy>&Dropdown2=<program>`), but whether Zoho's live form actually pre-selects those dropdown values on load — as opposed to just ignoring unrecognized query params — needs a real check in an actual browser (an automated headless check in this environment hit an inconsistent `net::ERR_ABORTED` on the iframe load that didn't reproduce for a real person in a real browser earlier, so this needs a human to actually look).

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

## Things Phase 5 leaves that Phase 6 (and later) should know

- **`gps_checks` and `flags` now exist** (Phase 5): `gps_checks` is 5 rows per attendance session, RLS-scoped like `attendance_sessions` (teacher own / RM by region / OM+CPO all) — a later reporting phase can join it for "% of checks actually verified" per teacher/school. `flags` is manager-only (no teacher-visible policy at all) and holds `gps_out_of_fence`/`late_clock_in` rows with a `resolved_at`/`resolved_by` pair — a later phase could add more `type`s (the column is text, not an enum, deliberately) without a schema change.
- **Only `clock_in`/`record_gps_check`/`resolve_flag` (authenticated, security definer) and service_role mutate these tables** — same "no raw client write path" rule as `attendance_sessions`. `detect_late_clockins`/`close_out_overdue_gps_checks` are service_role-only, called by the two new Edge Functions.
- **The two new Edge Functions are deployed, cron-scheduled, and confirmed running** (`check-closeout-1min`/`late-detect-1min`, every minute, both secrets set) — `gps_checks` rows now actually flip to `unverifiable` on schedule and missed clock-ins get flagged automatically, no manual `curl`/RPC calls needed to exercise them.
- **`notify_recipients_for_school()` (`supabase/migrations/0012`) is the one place "who gets notified about an incident at school X" lives** — reuse it rather than re-deriving RM-by-region lookups elsewhere (e.g. if a later phase adds more incident types).
- **`/flags` shows only *open* flags** (`resolved_at is null`); there's no resolved-flags history view yet — a later reporting/audit phase could add one by dropping the `is("resolved_at", null)` filter and adding a filter toggle.
- **The GPS sampler is 100% best-effort, matching the plan's "not auto-flagged" framing**: it can't run when the tab isn't foregrounded (no background geolocation), can't force a fix if the device denies/times out, and 30 s polling means a check due right at the boundary of two polls could sample up to ~30 s late — none of this matters for the `unverifiable`-not-flagged design, but don't repurpose `gps_checks.sampled_at` as a precise "exactly when this happened" timestamp in a later phase.

## Things Phase 6 leaves that Phase 7 (and later) should know

- **`origin` ('online'|'offline') now exists on `attendance_sessions` and `gps_checks`** — a later reporting phase can distinguish live vs. replayed records (e.g. "% of clock-ins taken offline"). Default is `'online'`, so pre-Phase-6 rows all read `online`.
- **`POST /api/sync` is the offline replay endpoint**, teacher-authenticated (cookie JWT), routing to the same `clock_in`/`record_gps_check_offline` RPCs the online path uses. If a later phase adds another offline-capable teacher action, add its RPC + a new `kind` branch there rather than a second endpoint — and keep the RPC idempotent on a client-supplied key, since the queue may replay it.
- **Feedback/clock-out is intentionally NOT in the offline queue** — it closes only via Zoho's webhook (`close_session_from_zoho`, service_role), and the offline feedback story is the Dexie draft → prefilled Zoho form (Phase 4). Don't "complete" the offline queue by adding a teacher-side close path; that was a deliberate scoping call (see DECISIONS.md).
- **`apply_gps_sample()` is the one place a GPS check's resolution + out-of-fence flag/notification logic lives** — both `record_gps_check` (online) and `record_gps_check_offline` delegate to it. Add new GPS-resolution behaviour there, not in either caller, to keep the two paths identical.
- **The service worker's Background Sync (`ymu-sync` tag) only wakes open window clients** (it `postMessage`s them; the actual drain runs in the page). If no tab is open when connectivity returns, the queue drains on the next visit instead — acceptable for this app, but note it before relying on truly-headless background sync.
- **Migration numbering**: `0013_offline_sync.sql` is the latest; next available is `0014_...`.
- **RLS tests**: `npm run test:rls` runs **eight** files (profiles, schools, events, calendar-sync-issues, attendance, gps-checks, offline-sync, notifications). The multi-suite `signInWithPassword` rate-limit caveat (below) still applies — run a single new suite standalone first.

## Things Phase 7 leaves that Phase 8 (and later) should know

- **`notification_queue.status` now specifically means the push channel** (a naming carry-over from Phase 3, when it was the only channel) — `email_status`/`email_sent_at` are the separate email-backup channel's own fields, `null` for any type that never gets email backup. A later phase adding a new notification type should decide up front whether it's email-eligible and set `email_status` accordingly at insert time (or leave it `null`).
- **`notification_preferences` has no row for most users** — absence means "enabled, default lead time." Don't write code elsewhere that assumes a row exists per user/type; always read through the same default-coalescing logic notify-dispatch uses (mirrored between `enqueue_reminder_notifications()`'s SQL `coalesce()`s and `dispatch-logic.ts`'s `DEFAULT_LEAD_MINUTES` — keep both in sync if a default ever changes).
- **The email daily cap (100/day, Resend free tier) is enforced entirely in `dispatch-logic.ts`'s `planDispatch()`**, by counting `email_status='sent'` rows since UTC midnight — not a separate counter table. If Resend's tier or the cap changes, that's the one constant to edit (`EMAIL_DAILY_CAP`).
- **Dark mode is device-local only** (user-confirmed) — there's no `profiles` column for it and no cross-device sync. If a later phase wants that, it's a new column + a small server action, not a rework of the existing toggle (which can stay as the localStorage-writing fallback for signed-out/offline).
- **`gps_out_of_fence`/`late_clock_in` (Phase 5) have no Settings toggle** — they're manager-facing and always sent via push (no email backup) regardless of any preference. A later phase adding manager-facing notification preferences would need its own UI; don't fold them into the teacher-facing 5-type list.
- **Push subscriptions self-clean on a 404/410 from the push service** — a stale `push_subscriptions` row (uninstalled app, revoked permission) disappears automatically the next time notify-dispatch tries it, no manual cleanup job needed.
- **Migration numbering**: `0014_notifications.sql` is the latest; next available is `0015_...`.

## Things Phase 4 leaves that Phase 5 (and later) should know

- **Attendance data now exists** in `attendance_sessions` (Phase 4): one row per clock-in→out cycle, with `clock_in_at`/`clock_out_at`, `clock_in_status`, `clock_in_distance_m`, and the feedback columns (`feedback_engagement`, `feedback_had_issue`, `feedback_issue_status`, `feedback_notes`, `feedback_submitted_at` — corrected in migration `0011` to match the real Zoho form, see DECISIONS.md). Phase 8 reports (hours, on-time rates, feedback) query this table. RLS already scopes it (teacher own / RM by region / OM+CPO all). An **open** row (`clock_out_at IS NULL`) is a teacher still on the clock / owing feedback — treat it specially in any hours rollup.
- **Only two RPCs mutate it** — `clock_in` (authenticated) and `close_session_from_zoho` (service_role only, called from `src/app/api/zoho-feedback/route.ts` when Zoho's webhook fires). Don't add a raw client write path; authenticated users have `select`-only. If a later phase needs an admin correction (e.g. a manager fixing a bad clock-out), add another RPC rather than granting UPDATE.
- **The on-time window is `ON_TIME_GRACE_MINUTES` (5)** in `src/lib/attendance/status.ts` + `clock_in`'s `p_grace_minutes` default. If a settings phase makes it truly per-school/global, thread a stored value into both (and pass it from the clock-in action).
- **The old "push feedback to Zoho" plan (Phase 9) is now backwards and probably dead**: feedback now originates *in* Zoho (the rework above), so there's nothing left to push there after the fact. `attendance_sessions.zoho_synced_at` and the `ZOHO_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` env vars are likely vestigial — confirm with whoever owns that phase before building anything against them.
- **Offline clock-in is not built** (Phase 4 was online-only per the plan). The pieces are seeded for it: `client_key` idempotency on the table + RPC, and the PWA/service-worker from Phase 0. A later offline phase can queue clock-ins client-side (Dexie is already a dep, and is now also used for the offline feedback draft — see `src/lib/attendance/offline-feedback-db.ts`) and replay them through `clock_in(p_client_key)` on reconnect; the server re-validates the geofence on replay.
- **`notification_queue` is ready for Phase 7**: `type` + `payload` + `send_at` + `status`. Phase 3 writes `time_changed`/`location_changed`/`teacher_changed`/`event_cancelled`; Phase 7 adds reminder types and the dispatcher.
- **`school_years`** still standalone (unused until Phase 9).
- **Migration numbering**: as of Phase 6, `0013_offline_sync.sql` is the latest; next available is `0014_...` (this bullet was written at Phase 5 when `0012` was latest — see the Phase 6 section above for the current count).
- **RLS tests**: `npm run test:rls` runs seven files as of Phase 6 (eight as of Phase 7 — see the section above); `npm run test` runs the credential-free unit tests (calendar client, classifier, attendance status). Widen the globs in `package.json` when adding more. Notes: `tests/events-rls.test.ts`'s "OM sees all" case has become flaky now that the real `calendar_events` table has grown past PostgREST's default 1000-row cap — flagged separately, not caused by anything in Phase 4/5. Running all six files in one process can intermittently hit Supabase's own `signInWithPassword` rate limit (each suite signs in several disposable users) — if `test:rls` reports "Request rate limit reached" instead of real assertion failures, wait a minute or two and re-run; it's an auth-endpoint throttle, not a test bug (see DECISIONS.md, Phase 5 verification entry).

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale.
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.
- **Phase 3 + multi-calendar sync finishers** (above): Google service account + each school's calendar shared to it; deploy `calendar-sync` + set Edge secrets (no `GOOGLE_CALENDAR_ID`); schedule the 5-min `pg_cron` job.
- **Phase 5 finisher** (above): the only thing left is the live "done when" browser/device walkthrough — everything else (deploy, secrets, cron) is done and confirmed running.
- **Phase 7 finisher** (above, "Finish Phase 7"): set the VAPID/dispatch-secret Edge Function secrets (values already generated, listed above); get a real Resend account and set its secrets; then the live-device walkthrough.
