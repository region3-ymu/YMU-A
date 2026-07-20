# NEXT_STEPS — YMU-A

Where to pick up. **Phase 4 (Clocking flow + feedback gate) is fully built and verified**, including the hosted parts — see HANDOFF.md for the full description and verification writeup (migration `0008` applied, `npm run test:rls` 60/60, live browser acceptance cycle against the real hosted project). A real, unrelated security bug in the Phase 3 calendar-match column protection was also found and fixed along the way (migration `0009`; see DECISIONS.md).

**Feedback was then reworked to a Zoho-hosted form + webhook** (product change, PRD-confirmed), and then two UX fixes landed on top (redirect home instead of straight into the feedback form after clock-in, a "Back" button on every page) — see "Finish the Zoho feedback setup" below for the one remaining thing to confirm (the webhook round-trip). Next feature work after that is **Phase 5** from the approved plan (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`) — read the plan for its scope.

Still-open pre-Phase-4 work also remains: Phase 3's multi-calendar sync review queue and the initial event-sync catch-up (below). **Multi-calendar sync is live-verified**: **50/68 calendars pinned**, **17 genuinely open** ([`calendar-sync-open-issues.csv`](calendar-sync-open-issues.csv), local artifact), 1 dismissed. Event-sync is still catching up (only ~9/50 pinned calendars had finished their initial full sync at last run) — keep running `npm run sync:calendar` or deploy the cron.

## Finish the Zoho feedback setup (one thing left to confirm)

Everything code-side is built. The real, fixed form URL (`https://zfrmz.com/MIVJGi5IlokeTf8oTsDR`, the one already embedded in every calendar event's description) is set in `ZOHO_FEEDBACK_FORM_URL`, and confirmed **live, twice** (once in an automated browser check, once by a teacher actually reaching `/clocking` with a real open session): the iframe renders the real Zoho form correctly. An earlier `curl -I` check on that URL had shown `X-Frame-Options: SAMEORIGIN`, which looked like a hard blocker (the initial iframe attempt did fail with `net::ERR_ABORTED`) — but it renders fine now in every subsequent check, so whatever caused that first failure isn't reproducing (possibly `curl`'s no-redirect response differing from where a browser ends up after following redirects into the actual form page). Not fully explained, but no longer blocking.

**What's NOT yet confirmed: the full round-trip.** A teacher has confirmed the form *displays* correctly with the right class prefilled, but no one has actually filled it out and submitted it for real yet — so whether Zoho's webhook fires, with what payload shape, and whether `src/app/api/zoho-feedback/route.ts` parses it correctly, is still unverified beyond a simulated `curl` delivery (see DECISIONS.md). Do this once the webhook is configured (step below):

1. **Build the form in Zoho Forms** with these fields — name each field's **Link Name** (in the field's properties in Zoho's form builder) to match, or note the actual names you use so the env vars below can be set to match instead:
   - `session_id` — single-line text, hidden (prefilled from the app, echoed back in the webhook so we know which class the feedback is for)
   - `school` — single-line text (prefilled with the school name)
   - `teacher` — single-line text (prefilled with the teacher's name)
   - `date` — date field (prefilled as `MM/DD/YYYY` — Zoho's commonly-documented prefill format, unverified against this specific field)
   - `class` — single-line text (prefilled with the class name)
   - `rating` — number, 1–5 (teacher fills in)
   - `summary` — multi-line text, required (teacher fills in)
   - `challenges` — multi-line text, optional (teacher fills in)
   - `students_present` — number, optional (teacher fills in)
2. **If any Link Name differs from the defaults above**, set the matching `ZOHO_FEEDBACK_FIELD_SESSION` / `_SCHOOL` / `_TEACHER` / `_DATE` / `_CLASS` / `_RATING` / `_SUMMARY` / `_CHALLENGES` / `_STUDENTS_PRESENT` env var.
3. **Configure the webhook**: Zoho Forms → Integrations → Webhooks → Configure Webhook.
   - Webhook URL: `https://<your-deployed-domain>/api/zoho-feedback`
   - Content Type: **application/json**
   - Payload Parameters: select `session_id`, `rating`, `summary`, `challenges`, `students_present` (the four feedback fields the teacher actually fills in, plus the session id — school/teacher/date/class don't need to round-trip back)
   - Custom Headers: add `x-zoho-feedback-secret` = the same value you set for `ZOHO_FEEDBACK_WEBHOOK_SECRET`
4. **Test it for real**: log in as a teacher with an open session, load `/clocking`, confirm the Zoho form actually renders inside the page (not the "form isn't configured yet" message, and not a blank box) with school/teacher/date/class already filled in. Submit it, and confirm the page updates to "Feedback received" within a few seconds (it polls every 4s) — if it doesn't, check the webhook delivery log in Zoho and compare the actual payload shape against what `src/app/api/zoho-feedback/route.ts` expects (this hasn't been tested against a real Zoho delivery, only a simulated `curl` one — the payload shape may need adjusting, see the comments at the top of that file and in `src/lib/attendance/zoho-feedback.ts`).
5. **Test the offline path too**: go offline (DevTools → Network → Offline) with an open session, fill and save the local draft form, go back online, and confirm the Zoho form loads prefilled with those answers too.
6. Decide whether the old Phase 9 "push feedback to Zoho via API" plan (and the `ZOHO_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` env vars, and `attendance_sessions.zoho_synced_at`) is still needed — probably not, now that feedback originates in Zoho instead of being pushed there. See DECISIONS.md.

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

## Things Phase 4 leaves that Phase 5 (and later) should know

- **Attendance data now exists** in `attendance_sessions` (Phase 4): one row per clock-in→out cycle, with `clock_in_at`/`clock_out_at`, `clock_in_status`, `clock_in_distance_m`, and the feedback columns. Phase 8 reports (hours, on-time rates, feedback) query this table. RLS already scopes it (teacher own / RM by region / OM+CPO all). An **open** row (`clock_out_at IS NULL`) is a teacher still on the clock / owing feedback — treat it specially in any hours rollup.
- **Only two RPCs mutate it** — `clock_in` and `clock_out_with_feedback`. Don't add a raw client write path; authenticated users have `select`-only. If a later phase needs an admin correction (e.g. a manager fixing a bad clock-out), add another SECURITY DEFINER RPC rather than granting UPDATE.
- **The on-time window is `ON_TIME_GRACE_MINUTES` (5)** in `src/lib/attendance/status.ts` + `clock_in`'s `p_grace_minutes` default. If a settings phase makes it truly per-school/global, thread a stored value into both (and pass it from the clock-in action).
- **Zoho export is unbuilt**: `attendance_sessions.zoho_synced_at` is a reserved nullable seam. The `ZOHO_*` creds are already in `.env.local`. Whichever phase owns integrations should build the exporter (submitted feedback → Zoho form API → stamp `zoho_synced_at`).
- **Offline clock-in is not built** (Phase 4 was online-only per the plan). The pieces are seeded for it: `client_key` idempotency on the table + RPC, and the PWA/service-worker from Phase 0. A later offline phase can queue clock-ins client-side (Dexie is already a dep) and replay them through `clock_in(p_client_key)` on reconnect; the server re-validates the geofence on replay.
- **`notification_queue` is ready for Phase 7**: `type` + `payload` + `send_at` + `status`. Phase 3 writes `time_changed`/`location_changed`/`teacher_changed`/`event_cancelled`; Phase 7 adds reminder types and the dispatcher.
- **`school_years`** still standalone (unused until Phase 9).
- **Migration numbering**: `0008_attendance.sql` is taken; next available is `0009_...`.
- **RLS tests**: `npm run test:rls` now runs five files (profiles, schools, events, calendar-sync-issues, attendance); `npm run test` runs the credential-free unit tests (calendar client, classifier, attendance status). Widen the globs in `package.json` when adding more.

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale.
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.
- **Phase 3 + multi-calendar sync finishers** (above): Google service account + each school's calendar shared to it; deploy `calendar-sync` + set Edge secrets (no `GOOGLE_CALENDAR_ID`); schedule the 5-min `pg_cron` job.
