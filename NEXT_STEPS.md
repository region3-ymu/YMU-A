# NEXT_STEPS — YMU-A

Where to pick up. **Phase 4 (Clocking flow + feedback gate) is fully built and verified**, including the hosted parts — see HANDOFF.md for the full description and verification writeup (migration `0008` applied, `npm run test:rls` passing, live browser acceptance cycle against the real hosted project). A real, unrelated security bug in the Phase 3 calendar-match column protection was also found and fixed along the way (migration `0009`; see DECISIONS.md).

**Feedback was then reworked to a Zoho-hosted form + webhook** (product change, PRD-confirmed), corrected once to match the real Zoho form's actual fields (migration `0011`, see DECISIONS.md), and had two UX fixes land on top (redirect home instead of straight into the feedback form after clock-in, a "Back" button on every page). All of that is done from the app's side — what's left is a short list of **manual Zoho-side steps** ("Finish the Zoho feedback setup" below); none of it blocks moving on.

**Next feature work is Phase 5.** ⚠️ Its scope was in an external plan file (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`) that does not exist in this environment (different machine/session) — before starting Phase 5, either paste its scope in or point to wherever that plan actually lives now. "Things Phase 4 leaves that Phase 5 (and later) should know" below is still accurate background regardless of what Phase 5 turns out to cover.

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
5. Decide whether the old Phase 9 "push feedback to Zoho via API" plan (and the `ZOHO_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` env vars) is still needed — probably not, now that feedback originates in Zoho instead of being pushed there. See DECISIONS.md.

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

## Things Phase 4 leaves that Phase 5 (and later) should know

- **Attendance data now exists** in `attendance_sessions` (Phase 4): one row per clock-in→out cycle, with `clock_in_at`/`clock_out_at`, `clock_in_status`, `clock_in_distance_m`, and the feedback columns (`feedback_engagement`, `feedback_had_issue`, `feedback_issue_status`, `feedback_notes`, `feedback_submitted_at` — corrected in migration `0011` to match the real Zoho form, see DECISIONS.md). Phase 8 reports (hours, on-time rates, feedback) query this table. RLS already scopes it (teacher own / RM by region / OM+CPO all). An **open** row (`clock_out_at IS NULL`) is a teacher still on the clock / owing feedback — treat it specially in any hours rollup.
- **Only two RPCs mutate it** — `clock_in` (authenticated) and `close_session_from_zoho` (service_role only, called from `src/app/api/zoho-feedback/route.ts` when Zoho's webhook fires). Don't add a raw client write path; authenticated users have `select`-only. If a later phase needs an admin correction (e.g. a manager fixing a bad clock-out), add another RPC rather than granting UPDATE.
- **The on-time window is `ON_TIME_GRACE_MINUTES` (5)** in `src/lib/attendance/status.ts` + `clock_in`'s `p_grace_minutes` default. If a settings phase makes it truly per-school/global, thread a stored value into both (and pass it from the clock-in action).
- **The old "push feedback to Zoho" plan (Phase 9) is now backwards and probably dead**: feedback now originates *in* Zoho (the rework above), so there's nothing left to push there after the fact. `attendance_sessions.zoho_synced_at` and the `ZOHO_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` env vars are likely vestigial — confirm with whoever owns that phase before building anything against them.
- **Offline clock-in is not built** (Phase 4 was online-only per the plan). The pieces are seeded for it: `client_key` idempotency on the table + RPC, and the PWA/service-worker from Phase 0. A later offline phase can queue clock-ins client-side (Dexie is already a dep, and is now also used for the offline feedback draft — see `src/lib/attendance/offline-feedback-db.ts`) and replay them through `clock_in(p_client_key)` on reconnect; the server re-validates the geofence on replay.
- **`notification_queue` is ready for Phase 7**: `type` + `payload` + `send_at` + `status`. Phase 3 writes `time_changed`/`location_changed`/`teacher_changed`/`event_cancelled`; Phase 7 adds reminder types and the dispatcher.
- **`school_years`** still standalone (unused until Phase 9).
- **Migration numbering**: `0011_zoho_feedback_real_schema.sql` is the latest; next available is `0012_...`.
- **RLS tests**: `npm run test:rls` runs five files (profiles, schools, events, calendar-sync-issues, attendance); `npm run test` runs the credential-free unit tests (calendar client, classifier, attendance status). Widen the globs in `package.json` when adding more. Note: `tests/events-rls.test.ts`'s "OM sees all" case has become flaky now that the real `calendar_events` table has grown past PostgREST's default 1000-row cap — flagged separately, not caused by anything in Phase 4/the Zoho rework.

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale.
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.
- **Phase 3 + multi-calendar sync finishers** (above): Google service account + each school's calendar shared to it; deploy `calendar-sync` + set Edge secrets (no `GOOGLE_CALENDAR_ID`); schedule the 5-min `pg_cron` job.
