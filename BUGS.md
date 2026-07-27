# BUGS — Zoho feedback → clock-out investigation (paused)

**Status as of writing:** paused while a Google Form–based version ships for
this week's PD sessions instead (branch `pd-week-google-form-feedback`,
fully documented in `NEXT_STEPS.md`'s top section — code done, manual Google
Form + Apps Script setup owed). This doesn't touch or resolve anything
below; it's a parallel, switchable path (`FEEDBACK_FORM_PROVIDER` env var).
This doc exists so a future session picking the Zoho thread back up has full
context without re-deriving everything from scratch.

## The bug

A teacher fills out and submits the real embedded feedback form at
clock-out, Zoho shows "Thank you! Your response has been submitted." — but
the corresponding `attendance_sessions` row **never closes**
(`clock_out_at`/`zoho_synced_at` stay `null`). The teacher stays stuck on
the "Feedback required" gate forever.

## Architecture (for context — see also HANDOFF.md/DECISIONS.md)

Zoho Forms doesn't support more than one webhook target per form, and a
pre-existing Google Apps Script already mirrors every submission into a
Google Sheet (likely feeding Looker Studio/manual review) — so instead of
pointing Zoho straight at our app, the chain is:

```
Teacher fills real Zoho form (embedded via iframe, session_id/teacher_id
prefilled as hidden fields via URL query params)
  → Zoho's webhook (Integrations → Webhooks on "YMU Teacher Feedback")
  → Google Apps Script doPost() (mirrors row to Sheet, THEN relays)
  → UrlFetchApp.fetch(...) to POST https://ymu-a-navy.vercel.app/api/zoho-feedback
  → close_session_from_zoho() RPC → attendance_sessions.clock_out_at set
```

## What is CONFIRMED WORKING (ruled out, do not re-investigate these)

1. **`/api/zoho-feedback` (our Next.js route) is 100% correct.** Tested
   directly via `curl` multiple times with real session/teacher UUIDs —
   secret check, field extraction, and the `close_session_from_zoho()` RPC
   call all work. Confirmed via direct DB checks (`clock_out_at`/
   `zoho_synced_at` set correctly) every time.
2. **The Apps Script `doPost()` code is 100% correct**, including the relay
   call. Confirmed three separate ways, all successful (verified against
   the DB, not just "no error shown"):
   - Direct `curl POST` to the deployed `/exec` URL with a real
     `session_id`/`teacher_id` in the body.
   - Running `testDoPostManually()` (a helper added to the script; calls
     `doPost()` with a fake event object) from the Apps Script **editor**
     directly — bypasses the Web App HTTP layer entirely.
   - A **brand new second deployment** was also created and tested directly
     — also worked. (Turned out to be unnecessary — see the curl `-L`
     gotcha below — but confirms the code itself isn't deployment-specific.)
3. **The real Zoho form ("YMU Teacher Feedback") renders and submits fine**
   for the actual user in their real browser — confirmed via screenshot
   showing Zoho's own "Thank you! Your response has been submitted." page.
   (My own automated test browser showed a blank iframe box during
   debugging — that was a **false negative specific to my testing tool**
   rendering a JS-heavy cross-origin iframe, not a real problem. Don't
   trust that signal again.)
4. **Zoho's Payload Parameters visually show `session_id`/`teacher_id`**
   correctly listed and mapped to the two hidden fields (confirmed via
   screenshot of the Webhooks Configuration screen — no red validation
   error, both rows present with the field dropdown correctly selected).
5. **Custom Headers being empty in Zoho's webhook config is CORRECT, not a
   bug** — Zoho calls the Apps Script, not our endpoint directly, so it
   never needs to send `x-zoho-feedback-secret`. That header is only needed
   on the Apps-Script-to-our-endpoint relay call, which is hardcoded inside
   the script itself.
6. Migration `0019` (the `p_teacher_id` ownership param on
   `close_session_from_zoho`) is applied and working.

## A real debugging trap hit along the way (don't fall for this again)

`curl -X POST .../exec` returns a `302` redirect to
`script.googleusercontent.com/macros/echo?...` — **this is Apps Script's
normal, successful response shape**; the script has already finished
executing by the time this redirect is returned. If you add `curl`'s `-L`
flag to follow it, curl (by default, for a 301/302) **silently converts the
POST to a GET** on the follow-up request, and that GET to the echo URL can
return a confusing Google Drive "Sorry, unable to open the file at this
time" error page — **this is a curl artifact, not a real failure.** The
only reliable way to check if a POST to `/exec` actually worked is to check
the database directly (`attendance_sessions.clock_out_at`), never the
displayed curl response body.

## What is STILL BROKEN / UNCONFIRMED

The core mystery: **the pieces we can test in isolation all work, but a
real end-to-end submission through the real Zoho form still doesn't close
the session.** Last real test session created for this:
`9c373934-461c-470c-a984-e1290bfb2f8d` (teacher_id
`6ad0b239-394c-4ffd-8b80-ad7cda748c4e`, "Seed Teacher") — still open as of
the last check, despite the user confirming the real form submitted
successfully on Zoho's side.

### Two diagnostic checks were requested but never got an answer — do these first

1. **Open the Google Sheet the active Apps Script writes to** (see the
   "two projects" confusion below for which one), find the newest row
   (matching the real test submission's timestamp), and check: are the
   `session_id`/`teacher_id` columns **populated with real UUIDs, or
   blank**? This is the single most informative check left — it tells you
   definitively whether Zoho is actually sending those two hidden fields'
   values at all.
   - If blank → Zoho isn't applying the URL-prefill to those hidden fields
     on real submission (even though the fields exist and the URL is built
     correctly on our side) — likely a Zoho quirk specific to hidden
     fields, or the Payload Parameters weren't actually **saved** (no Save
     button was ever explicitly confirmed clicked — worth checking for one
     at the bottom of the Webhooks Configuration page).
   - If populated → the relay is failing somewhere between the Sheet write
     and our endpoint on this specific real path, which contradicts item 2
     above and needs fresh investigation (maybe a quota, a timeout on the
     `UrlFetchApp.fetch` call under real load, etc).
2. **Apps Script → Executions, find the `doPost` matching the real
   submission's timestamp, read the `RAW payload:` log line.** Confirms the
   same thing from the other side. Note: `doGet` executions have zero logs
   by design (a plain health check with no `console.log`) — don't confuse
   those with a real `doPost` entry when scanning the list.

### Unresolved: TWO different Google accounts / Apps Script projects exist

- **`region3@ymu.org`** — project "teacher feedback-soho", up to **Version
  5**, HAS the relay + logging code we've been editing all session. Its
  deployed URL:
  `https://script.google.com/macros/s/AKfycbzD6Ea3JSyofwb_ipH8uMECh2BOmsiEzSw9yJy3G7TPG2h5MAkDDIt8QVoPr6ej1zMSPA/exec`
  — this matches what's configured as the Webhook URL in Zoho (confirmed by
  the user reading it directly from the Zoho Webhooks Configuration
  screen), so Zoho *should* be calling this one.
- **`ymuclassroom@youngmusiciansunite.org`** — a **different, older**
  project, only **1 version**, does NOT have the relay/logging code (an
  earlier, simpler version of the script). Its own deployed `/exec` URL was
  **never actually obtained or compared** against Zoho's configured
  Webhook URL. Editor:
  `https://script.google.com/u/2/home/projects/1ilUzQTrzODkhn53lhoboaFjA5ULLLG4lchESYdmZrTyPVRP-9QbbhMRF/edit`

**Action for next session:** get this second project's actual `/exec`
deployment URL and compare it byte-for-byte against Zoho's Webhook URL
field. Also check Zoho for any **other** active automation on the "YMU
Teacher Feedback" form (Zoho Flow, Automation Services, etc. — visible in
the left sidebar under Integrations) that might independently fire on
submit and be hitting the *other* (wrong/older) script instead.

### Also unresolved: two different Google Sheet IDs were mentioned, never reconciled

- `https://docs.google.com/spreadsheets/d/1xl6SKQZRokw7MSjEbXg_QR-IWSa2AUcvhYEn-Ee6b6Q/edit` —
  given early on when confirming the sheet exists/opens/has editor access.
- `https://docs.google.com/spreadsheets/d/1qk3ILE_aM-Tv7NV7unI1Fm9cug44zYD-ycyW2CES7kI/edit?gid=848806522` —
  given later via "Open container" from inside the `region3@` Apps Script
  project.

These are **different spreadsheet IDs**, not the same file at different
tabs. Never reconciled which one the active script actually writes rows
to, or why two IDs came up. Worth clarifying in the next session — it may
be a clue tied to the two-projects confusion above.

### `ZOHO_FEEDBACK_FORM_URL` — confirm what's actually live on Vercel right now

History of values tried (Vercel's current value can't be viewed, only
overwritten, so **don't assume** — re-set it explicitly and redeploy before
testing again):

1. `https://zfrmz.com/MIVJGi5IlokeTf8oTsDR` — the original, years-old
   guess. Confirmed via `curl -I` that this **302-redirects** to the
   formperma URl below, and that redirect hop itself carries
   `X-Frame-Options: SAMEORIGIN` — which a real browser's iframe embed is
   expected to honor and block on (matches an ERR_ABORTED finding recorded
   in DECISIONS.md from an earlier phase). Avoid using this one directly.
2. `https://forms.zoho.com/ymuclassroomyoungmusi1/form/TeacherFeedback` —
   the URL behind the form's own "Access Form" button. Confirmed via
   `curl -I` this returns a flat **HTTP 400** — broken, likely a
   builder/owner-only preview link, not a real public form URL. Don't use.
3. **`https://forms.zohopublic.com/ymuclassroomyoungmusi1/form/TeacherFeedback/formperma/rZngTydkG5DLUzVVsI-iOKPq_TJA-YqrDv2BrVdIeos`**
   — pulled directly from Zoho's own Share → Embed → iframe tab, i.e. Zoho
   itself asserts this is the correct embeddable link. Confirmed via
   `curl -D -` this returns `200`, no `X-Frame-Options`/CSP framing
   restriction, and ~194KB of real form HTML titled "YMU Teacher Feedback".
   This is the one that should be set. **Last known state: `.env.local` was
   updated to this value; it is NOT confirmed that Vercel's production env
   var matches** (the user redeployed once after setting the
   `forms.zoho.com` value, i.e. option 2 above — an intentionally broken
   one — was live at that point; whether it was ever corrected to the
   formperma URL on Vercel specifically was not re-confirmed before this
   session paused). **First thing to check in a new session: what is
   actually set on Vercel right now, and does the real form load with the
   right questions when visited fresh.**

### The wrong Zoho form from earlier in this investigation

A completely unrelated form, **"Teaching Artist Interview Evaluation"**
(a hiring/interview scoring rubric, nothing to do with class feedback), had
`session_id`/`teacher_id` hidden fields and a webhook accidentally
configured on it earlier in this same investigation, before the correct
form ("YMU Teacher Feedback") was identified. **Never confirmed whether
this was cleaned up** (removing the two stray hidden fields, turning off
its Webhooks Status toggle). Worth checking it's not still silently active
and causing any confusion.

## Known test IDs (for continuity, not secrets)

- Seed teacher (`teacher@ymu.test`) profile id:
  `6ad0b239-394c-4ffd-8b80-ad7cda748c4e`
- Seed Test School id: `0148faa1-0e62-4b2b-b58b-7416e30d509a`
- Seed Test Class event id: `8963d176-7c3f-4626-b911-600fb88192a0`
- Currently-open, never-closed real test session:
  `9c373934-461c-470c-a984-e1290bfb2f8d`
- Old resolved test session (Test Teacher / Brownsville, now closed + flag
  resolved): `f8e52696-2000-41dd-972c-808ac51ffae8`

## Secrets referenced during this investigation (values NOT repeated here on purpose)

`ZOHO_FEEDBACK_WEBHOOK_SECRET` and the newly-generated
`CALENDAR_SYNC_SECRET` were both used verbatim in this chat session while
debugging — check `.env.local` / Vercel / Supabase Edge Function secrets
for the current real values rather than reading them out of chat history;
deliberately not pasting live secret values into a file that gets committed
to git.

## Unrelated fixes made during this same session (already committed, keep these)

- `sw-update-prompt.tsx`: a real reload-race bug (fixed) and a
  `serwist.update()` synchronous-throw console error (fixed with a
  try/catch — the library still logs the line internally, that part is
  cosmetic and harmless).
- `CALENDAR_SYNC_SECRET` had never been generated at all — a new value was
  created; needs to be set consistently in the Edge Function secret, the
  Supabase Vault secret (`calendar_sync_secret`), and Vercel. See
  NEXT_STEPS.md for the exact SQL/steps — this is unrelated to the Zoho
  bug above but was found in the same debugging session.
- Migration `0021` (report hours = scheduled duration, auto-resolve
  `feedback_stuck` flag on Zoho close, `teacher_directory()` region
  derivation) — unrelated to this bug, already applied and documented in
  HANDOFF.md/NEXT_STEPS.md.

## The user's plan (for whoever picks this up)

The Zoho integration is being **paused, not abandoned** — a new branch will
ship a **Google Form** version for near-term use instead (simpler, same
Apps-Script-relay pattern likely reusable almost as-is, avoids Zoho's
one-webhook-per-form and payload-parameter-mapping fragility entirely).
This document exists so a future session can return to the Zoho path with
full context instead of re-discovering all of the above from zero.
