# NEXT_STEPS — YMU-A

## 🟡 NOT APPLIED YET — migrations 0076–0080 (2026-08-21)

Eight migrations are written, committed and **not pushed**. Everything below is
inert until they are applied. There is a single pasteable file in
`~/Downloads/YMU-A — migrations 0076-0083.sql`, wrapped in one transaction, or:

```bash
supabase db push
```

What they do, shortest first:

- **0076** — late-clock-in resolutions become a reason CODE plus optional prose,
  instead of free text. Also fixes `flags/actions.ts` dropping `p_notes`
  entirely, which is why 44 of the first 93 resolved flags have no reason on
  record. Also widens `admin_edit_attendance` / `admin_create_attendance` to the
  same six roles the UI already lets through — an `academic_manager` or
  `administrator` used to see the form and get a raw SQL exception on submit.
- **0077** — back-to-back carryover. `auto_clock_in_rules` + 
  `auto_clock_in_back_to_back()`, called from `late-detect` BEFORE
  `detect_late_clockins()`. Seeds exactly two rules: Kevin Bodniza at Horace
  Mann and Jose Heredia at South Dade Middle. The other 21 detected runs are
  visible with a toggle at the foot of /schedules and stay OFF until YMU says
  otherwise. Adds `'carryover'` to `attendance_sessions.origin`.
- **0078** — spreadsheet gaps: the Flags tab's reason/lateness/auto-resolver
  columns, the Attendance tab's manager-edit trail and afterschool flag, and
  three new tabs. Moves the Attendance year window out of `sheet-tabs.ts` and
  into `school_years` — hardcoded, it would have emptied the tab on 2027-07-01.
- **0079** — `substitutions`. /substitutes can now record who covered a class
  and why the assigned teacher was away.
- **0080** — the missed-clock-in follow-ups: outcome, absence reason, notice
  channel, excused, and a LINK to the substitution.
- **0081** — Tutoring owes no feedback form. A patterns table plus a BEFORE
  INSERT trigger, because five different functions create an attendance
  session and a rule in one of five call sites will be wrong within a month.
- **0082** — removes the mid-class GPS checks entirely. The clock-in is
  untouched. See below.
- **0083** — **the speed one.** Every RLS policy's identity lookups now run
  once per query instead of once per row. See below.

### After the push, one command, in this order

```bash
npm run sync:sheet:full && npm run sync:sheet
```

The tab sync rewrites Flags and Attendance with their new columns and creates
Substitutions, Clock-in attempts, GPS checks and Ticket messages. **The
`*_summary` tabs reference columns positionally**, so check those pivots still
resolve afterwards — Flags gained 10 columns and Attendance gained 4.

### Why the app was slow, and what 0083 does about it

Measured from `pg_stat_statements` on production, not guessed. The /schedules
`calendar_events` query: **6,396 calls, 158 ms mean, 5.4 s worst, and 17,023
shared blocks per call** — 136 MB of buffer reads to return a fortnight of
classes from a 57 MB table. A second `calendar_events` query averaged 358 ms at
23,985 blocks.

The same query with RLS out of the way: **3.7 ms, 633 blocks, index scan.**

It is not the policy's logic, it is when the policy runs. `calendar_events_select`
calls `auth.uid()`, `current_sees_all_regions()`, `current_app_role()` and
`current_app_region()` bare, so each lands in the row filter and runs PER ROW —
and each does its own `select from profiles`. A Regional Manager opening two
weeks of classes pays thousands of profile lookups to be told the same answer
every time.

Wrapping each in a scalar subquery moves it into an InitPlan, evaluated once per
statement. Measured on the same query in the same session: **52.6 ms bare vs
25.7 ms wrapped**, and that is as `service_role`, where
`current_sees_all_regions()` returns true immediately and short-circuits the
rest. For a Regional Manager, where every branch is really evaluated, the gap is
those 17,000 blocks.

0083 rewrites all 36 affected expressions across 28 policies mechanically, then
asserts three invariants or rolls back: no policy dropped, no policy changed in
anything but its parenthesisation, and no bare identity call left. The
transformation was dry-run read-only against all 35 live policies first — 0
invariant violations, 0 broken schema prefixes, 0 double wraps.

Shipped alongside it, and this is the part users will actually feel: the app had
**no `loading.tsx` and no `Suspense` anywhere**. Every screen is server-rendered
on demand and queries the database, so a tap on the bottom bar changed nothing
on screen until the whole response came back — which is why people tapped three
times. Worse, for a dynamic route `<Link>`'s default prefetch reaches only as
far as the nearest loading boundary, so with none there was nothing to prefetch
at all.

There are now eight `loading.tsx` files over a shared `PageSkeleton`, plus a
pending ring on the tapped bottom-nav tab via `useLinkStatus`. That covers both
halves: the tab responds to the touch, and the page area shows its shape
immediately.

**Still open, not fixed here** (both are DB CPU, not page latency, but they tax
everything else on a small instance):

- `enqueue_reminder_notifications()` — 44,548 calls at **112.6 ms mean**, 5,016
  seconds of total DB time. Runs every minute.
- `detect_late_clockins()` — 45,164 calls at **95.5 ms mean**, 4,313 seconds.
  Also every minute.

So roughly 200 ms of database work every minute, forever, before any user asks
for anything. Worth a look next.

- `calendar_events.raw` is 24 MB of the table's 57 MB and is read by exactly one
  page (`/schedules/[id]`). Moving it to a side table would shrink every other
  query's working set.

### GPS checks removed (0082)

649 of 654 were `unverifiable` with no position ever recorded; 4 succeeded, all
sampled 18–33 seconds after coming due. The sampler could only take a fix while
the app was **foregrounded**, and no web API changes that — a service worker has
no `navigator.geolocation`, and Periodic Background Sync is Chromium-only and
grants no location. Nobody holds a phone open for eighty minutes while teaching.

YMU's call (2026-08-21): remove it. A table that says "unverifiable" 649 times
is worse than no table, because it looks like evidence.

**The clock-in is deliberately untouched.** Every gate stays: geofence, archived
check, overdue-feedback block, idempotent `client_key`, offline clamp, same-day
rule, auto-close of the previous open session. A teacher can still clock in at
any point during their class — that is the same-day rule with no upper bound,
and 0082 changes nothing about it. The one line removed from `clock_in()` is the
insert that created the three check rows.

Gone with it: `gps_checks`, `record_gps_check`, `record_gps_check_offline`,
`close_out_overdue_gps_checks`, `flags.gps_check_id`, the `check-closeout` Edge
Function and its cron (unscheduled by the migration), the client sampler, the
offline queue's `gps_check` kind, and the planned GPS-checks spreadsheet tab.

If the "did they stay" question comes back, the buildable answers are a
mid-class push the teacher taps (the push infrastructure already exists), or a
GPS clock-OUT at the end of class — two verified points instead of five
unverifiable ones.

### The Google Calendar write is built and switched OFF

Confirming a substitute records it in the app and tells the manager the Google
event still needs editing by hand. That is deliberate, and it is not a code
problem:

1. `src/lib/google/calendar.ts` requests `calendar.readonly`. The write path
   uses `CALENDAR_WRITE_SCOPE` (`calendar.events`), which is already there.
2. **The service account needs "Make changes to events" on all ~109 school
   calendars.** It cannot grant itself that — a service account is not an
   owner, so `acl.insert` is refused. Every calendar's owner has to re-share.
   This is the actual blocker and it is a Google Workspace job.

Once that access exists:

```bash
# in Vercel, then redeploy
GOOGLE_CALENDAR_WRITE_ENABLED=true
```

`calendar-sync` already suppresses the `teacher_changed` notification when a
confirmed substitution explains the swap, so turning this on will not email a
class about a change the manager just arranged.

Why this matters more than it sounds: `calendar_events.teacher_ids` comes from
the Google event's attendees, so **a substitute who is not on the event cannot
clock in.** Until the write is on, editing the attendee by hand is not optional
bookkeeping — it is what makes the substitution work.

---

## 🟡 ONE THING LEFT, AND IT IS YMU'S TO DO — Daniel Soto's 16 invites

A teacher is attached to a class by matching the Google Calendar invite's
attendee email against their app login, exactly and case-insensitively. Every
mismatch is now resolved except one, and it is on the calendar side:

**Daniel Soto's 16 classes at West Homestead K-8 are invited to
`daniel.s.0903@outlook.com`.** YMU confirmed the app's `sotod1403a@gmail.com`
is his real address, so the invites are the thing that is wrong. YMU is
deleting and re-uploading those events with the correct address. Nothing to
change in the app — and nothing else in the whole 2026-27 calendar is
unmatched.

**After they are re-uploaded**, run this so the existing rows pick him up —
a plain sync is NOT enough, see the incremental-sync note below:

```sql
select public.relink_event_teachers();
```

### ✅ James Perez, fixed 2026-08-12 — 360 classes recovered

The app carried `jamezperez711@gmail.com`; YMU's CSV and the calendar invites
both said `jamesperez711@gmail.com`. The `z` was a typo hardcoded in
`scripts/onboard-real-users.ts`, which is now corrected there too — left alone
it would have CREATED A DUPLICATE ACCOUNT on the next run, because that script
looks accounts up by email.

His 360 classes at Madison Middle and Brownsville Middle had no teacher, so
nobody could clock into any of them. Login changed in place, re-linked, done.

**He must be told his login changed**, and it cannot be self-served: `ymu.org`
still has no SPF/DKIM/DMARC, so "Forgot password?" delivers nothing.

## ✅ The whole app is in one spreadsheet now (2026-08-12)

Juan Pelaez asked for all the app's data in one spreadsheet, a tab per thing,
so he can analyse and build dashboards without asking for a code change. Seven
new tabs alongside the existing `Feedback` one, live and populated:

| Tab | Rows today | What it answers |
|---|---|---|
| `Attendance` | 6,886 | Late clock-ins, absences, hours — by teacher, school, region |
| `Tickets` | 0 | Live ticket state with SLA verdicts |
| `Flags` | 4 | GPS and late-clock-in escalations |
| `Schools` | 110 | Reference list to group any tab by region |
| `Teachers` | 58 | Reference list, regions derived from where they teach |
| `Programs` | 96 | The objective lists on the feedback form |
| `Ticket insights` | 0 | Root cause × category, pre-aggregated |

Refreshed hourly by `sheet-tabs-hourly` (cron, minute 7). By hand:
`npm run sync:sheet:full`.

### The Feedback tab was lying about tickets, and now says so

`feedback_for_sheet()` denormalises six mutable ticket columns into each
feedback row, and the watermark is one-shot — a row is written once and never
revisited. Since `submit_class_feedback()` creates the feedback and its ticket
in the same transaction and the cron runs two minutes later, **the sheet
captured every ticket at birth**: status `Open`, root cause blank, forever,
however it was later resolved.

Those columns are now labelled `(at submission)` and point at the `Tickets`
tab, which is the live answer. The positions could not be reused — months of
rows sit under them.

### Google's quota, measured rather than assumed

The binding limit is **60 requests per minute per USER**, and a service account
is one user — so the hourly tab sync and the two-minute feedback sync share one
budget. (Per project it is 300/min, and per day is unlimited, so neither of
those is the constraint.)

Measured with a wrapped `fetch`, not estimated:

| | Requests | When |
|---|---|---|
| Tab sync | **24** (1 read, 23 writes) in ~12s | hourly |
| Feedback sync | 2 idle, 3 when appending | every 2 min |
| **Worst single minute** | **27 of 60 — 45%** | |

It was 36 before, at 60% of the quota with the two syncs able to collide.
`ensureTab` and `ensureGrid` each fetched the spreadsheet's metadata, twice per
tab, for something that cannot change mid-run: 14 of the 36. `readTabMeta()`
now reads it once per run and passes it down. The run also went from 33s to
12s.

Every Sheets call goes through `sheetsFetch()`, which retries 429 and 5xx with
truncated exponential backoff and jitter — Google's own recommendation. Without
it a collision would leave a tab an hour stale over a condition that clears in
seconds.

**Headroom check:** even someone running `npm run sync:sheet:full` by hand at
the exact minute the cron fires is 24 + 24 + 3 = 51 of 60, and the backoff
covers the rest. Adding tabs costs ~3 requests each, so there is room for
roughly ten more before this needs rethinking.

### Two traps worth remembering

- **PostgREST truncates at 1000 rows and reports success.** The first run
  mirrored 1000 of 6,855 attendance rows and said it was done. Every
  service-role read of a set-returning function pages until a short page.
- **`values.update` cannot grow a tab's grid.** A new tab is 1000×26 and
  writing 6,886 rows into it fails with a 400 about grid limits. The exporter
  resizes first.

### If Juan wants real dashboards later

Looker Studio connects straight to PostgreSQL and reads Supabase live, with no
export step. It needs a read-only database user, not the service role. The
fact/dimension split above is exactly the shape it wants, so these tabs are
also a fine staging layer — nothing here has to be undone.

## ✅ FIXED: 2,598 classes were filed under the wrong school (2026-08-12)

Kevin Bodniza reported seeing Young Men's Preparatory Academy and North Miami
MS in his schedule, and he teaches at neither. He was right, and it was not a
permissions bug — that was checked first and is sound:

- `calendar_events_select` restricts a teacher to `auth.uid() = ANY
  (teacher_ids)`, so a teacher can only ever read a class they are named on.
- `/schedules` queries with the user's own client, so RLS applies. No bypass.
- Every event he saw genuinely carries `bodniza.kevin@gmail.com` as a Google
  Calendar attendee.

**The classes were his. The school on them was wrong.** His 180 "Young Men's
Preparatory Academy" classes come from the calendar pinned to **Horace Mann
Middle School** — where he does in fact teach.

### Why, and why it matters more than a wrong label

Same shape as the teacher-linkage bug 0035 fixed. An event's school is resolved
when the row is first written, and the sync is incremental. Every time a pin
was corrected — Hialeah/Homestead, Dr. William Chapman, John A. Ferguson, and
the re-subscription of all 111 calendars — the events already stored kept
pointing at whichever school the pin used to name.

`school_id` is what **clock-in validates the geofence against**. The mismatched
pairs were up to **11.2 km** apart, so a teacher standing in their own
classroom would have been told they were nowhere near it. It also decides which
region a ticket routes to.

`relink_event_schools()` (0036) re-files every event under its calendar's
current pin. 3,253 rows corrected; 0 mismatches remain out of 14,935. Kevin now
shows exactly Horace Mann, Paul L. Dunbar and Carrie P. Meek.

**Run it after any re-pin**, alongside the teacher one:

```sql
select public.relink_event_schools();
select public.relink_event_teachers();
```

## ✅ Reset to zero for the 2026-27 start (2026-08-12)

Every operational table is empty. Audited by enumerating **all 20 public
tables**, not by trusting the list of ones that had been deleted from — which
is how the first pass missed four things that the cron had recreated or that
nobody had thought of.

| Emptied | Kept |
|---|---|
| attendance_sessions, clock_in_attempts | schools (110) |
| gps_checks, flags | calendar_events (15,896) |
| feedback_submissions | profiles (63) |
| tickets, ticket_messages | programs (7) + 194 objectives |
| notification_queue | push_subscriptions (26 live devices) |
| the Google Sheet (1,014 rows) | notification_preferences |

`ticket_number_seq` restarts at 1, so the first real ticket is #1.

### The four things a table-by-table audit caught

- **The cron keeps working while you delete.** A `late_clock_in` flag and three
  notifications appeared *after* the first wipe, generated by the office test
  class at 5:40 PM. Deleting operational tables is not a one-shot action while
  anything is still scheduled — check again afterwards.
- **The office test classes had to go too.** Tomorrow's 10:00 fixture would
  have produced a late flag and a reminder for a class nobody was ever going to
  teach — a red badge on the managers' Flags page on day one. Recreate them
  whenever you want to demo: `node --env-file=.env.local
  scripts/office-test-setup.ts` re-times the shifts to the day you run it.
- **`app_feedback` is a manager inbox too**, and nothing had ever cleared it.
  It held one report — see below. Resolved rather than deleted.
- **The school year was still called "Seed Test Year"**, the name the QA
  fixture gave it, in production, on screen. Its dates were already right.
  Renamed to `2026-27`.

Also removed: push subscriptions belonging to the 9 archived teachers, who
would otherwise have kept receiving notifications for a job they no longer do.

### James Perez's report is the field evidence for the email bug

At 12:11 PM today he used the in-app "report a problem" button:

> "No clock in! At Brownsville middle from 12-1"

Brownsville is one of his two schools, and his 360 classes there and at Madison
had no teacher attached because the app had `jamez` where the calendar had
`james`. He was reporting the exact bug, hours before it was found from the
other end.

It is marked resolved rather than deleted: a real teacher's report of a real
fault is worth more as a record than as a clean row count.

## 🟢 START HERE — everything is applied; what remains is a test pass

Every item from the previous handoff is closed. The objective selector is
built, applied and verified against production; Lehrman is geocoded; Lentin's
calendar is subscribed and pinned; the teacher roster is reconciled. Migration
0032 and the web code that matches it are both live.

**What is left is one manual test pass** — the full script is under "How to
test it" below. Everything else on this page is a record of what was done.

### The 2026-27 schedule as it stands (13 Aug 2026 – 7 Jun 2027)

| | |
|---|---|
| Classes | **6,182** — 6,166 with a teacher, 16 without (Soto, above) |
| Schools with classes | 35 of 109 |
| Teachers with classes | 29 of 49 active |

Both gaps are real data, not sync failures. Every one of the 74 schools without
classes **already has its Google calendar pinned and syncing** — the calendars
are simply empty for 2026-27.

- **No elementary school has any classes.** 0 of 39. YMU confirms this is
  expected.
- **West is barely scheduled at all**: 22 of its 23 schools have no 2026-27
  classes, and 21 of those have never had a single event in any year. It is the
  region that most deserves a second look.
- 27 schools have history from earlier years but nothing yet for 2026-27, which
  is what "still being loaded into Google" looks like from here.
- **20 teachers have an account and no class.** Expected while the schedule is
  still being loaded, but worth re-checking once YMU says it is complete —
  after that, an account with no classes is either someone who left or an
  invite that names the wrong address.

Re-run these two whenever you want the current picture: `npm run
calendar:coverage`, then `select public.relink_event_teachers();`.

Two things nobody owes any work on but that will keep showing up:

- **`calendar_sync_issues` will re-open two entries on every sync**:
  `Mandarin Lakes K-8` (a real calendar for a school YMU is not running) and
  `schedule@ymu.org` (the owning account's own personal calendar, never a
  school). Both are answered, not outstanding. They stop reappearing only if
  the Mandarin calendar is un-shared in Google; resolving them in-app is
  cosmetic and lasts until the next 5-minute sync.
- **Six pins whose calendar name disagrees with the school name** are the known
  legitimate spelling variants (e.g. "Carrie P. Meek" pinned to "Carrie P.
  Meek/Westview K-8"). `npm run calendar:coverage` lists them every time; read
  them, do not auto-correct them.

**Still deferred, unchanged:** mentors are a separate user type with their own
clock-in and a different form. YMU explicitly deferred it; do not model it yet.

### 🔴 The one real gap: `ymu.org` cannot send email at all

Confirmed by DNS on 2026-08-12: `ymu.org` has **no SPF record, no DKIM key and
no DMARC record**. Its MX points at Google Workspace, so incoming mail is fine,
but nothing is set up to authorise outgoing mail from anywhere.

That is why Resend refuses to relay, and it is bigger than Resend: signup
confirmation, "Forgot password?" and every notification email are all dead
until it is fixed. It also means a teacher whose login email is wrong is
**unrecoverable without an admin**, which is why the five email conflicts on
this page were settled by evidence rather than by guessing.

Two ways out, neither needing a paid plan:

1. **Google Workspace SMTP relay** (recommended — no new vendor, no DNS
   change). Supabase → Project Settings → Auth → SMTP: host `smtp.gmail.com`,
   port `587`, username a real Workspace mailbox (e.g. `noreply@ymu.org`),
   password an **App Password** (requires 2-Step Verification on that account).
   Sends as a genuine ymu.org mailbox from Google's own IPs. ~2,000
   recipients/day on Workspace.
2. **Brevo** — 300 emails/day free, and it verifies a **single sender address**
   by emailed link rather than a whole domain, so it works with no DNS access
   at all. SendGrid is no longer an option: its permanent free tier is gone as
   of 2026 (60-day trial, then paid). Mailjet's free tier is 6,000/month.

Either way, **add SPF and DKIM to `ymu.org`** when someone has DNS access.
Google Workspace generates the DKIM record from Admin console → Apps → Google
Workspace → Gmail → Authenticate email; SPF is one TXT record. Without them,
mail sent as `@ymu.org` from any provider is far more likely to land in spam.

---

## ✅ Teacher roster reconciled and CLOSED (2026-08-12)

Against `Teacher_Name_Email_Match - Name-Email-Phone.csv` (48 names). All 48
have an account, every active teacher has a phone, and YMU answered each of the
five email conflicts:

| Teacher | Answer | Why it matters |
|---|---|---|
| Michael Cooley | **app wins**, untouched | already signed in successfully with `michael.c00000ley@` (digit zeros) |
| James Perez | **app wins**, untouched | already signed in with `jamezperez711@` |
| Daniel Soto | **app wins** | the gmail is correct; the CSV's outlook address is stale |
| Jose Heredia | **CSV wins** — now `jherediaymu@gmail.com` | changed in place |
| De Anthony Williams | app already had it | the CSV was the file missing data |

**Cooley and Perez are settled by evidence, not preference** — both have
already logged in with the app's spelling. That is worth more than either
file, because the whole risk here was picking a plausible-looking address that
turns out to be dead: "Forgot password?" still cannot deliver mail, so a wrong
login is unrecoverable without an admin.

**Jose Heredia was changed in place, not created-then-deleted** as literally
asked. He has zero attendance sessions, feedback and tickets, so the two are
identical in outcome — and an in-place update keeps the same `profiles` row,
cannot orphan an `auth.users`, and cannot half-succeed between the two steps.

**Richard Pis's phone was left at the app's `352-681-9218`** — YMU is not using
him this year. Note that neither 352 nor 353 is a Miami area code, so if he
ever comes back, ask him rather than trusting either file.

### Also from that reconciliation

- **Created:** David Maden (`banddave@aol.com`) and Lilia Hernandez
  (`lhvega1988@gmail.com`), both `teacher`, password `ymu12345`, phones from
  the CSV.
- **25 missing phone numbers filled in** from the CSV. Zero active teachers
  are now without one.
- **9 archived** (not deleted — `archived_at`, so history survives and it is
  reversible): Achilles Acevedo, Adrian Gonzalez, Alain Williams, Candice
  Morgan, Joshua Leal, Reinier Reyes, Rodrigo Tavara, Samuel Collazos, Watson
  Joseph Chandler.
- **`Emilio Medrano (teacher test)` was deliberately NOT archived** even though
  it is not on the CSV. It is the account the teacher-side flow gets tested
  with, and it is needed to test the objective selector. Archive it once
  testing is done.

Teacher totals now: **49 active, 9 archived.**

---

## ✅ Done 2026-08-12: the feedback form's objective selector

Migration `0032_feedback_objectives.sql`, applied to production in three chunks
and verified against the live catalog. Section 2 of the daily form is no longer
"pick a pillar, then chips inside it" — it is one flat, required multi-select
over the program's own objectives.

### Three decisions that override the written spec

Each looks like a bug if you only read the spec, so all three are restated in
the migration header and in `src/lib/feedback/objectives.ts`:

- **The teacher does not pick the program.** The spec has a dropdown; YMU cut
  it. The program is read from the calendar title and shown read-only — which
  is precisely why the "Other" escape hatch has to exist.
- **Music Production runs.** The spec omitted it by mistake. 30 objectives.
- **Beginner Strings, Orchestra and Concert Band are one program**, not three.

### What changed

- `feedback_submissions` dropped `primary_focus_pillar` and
  `specific_topic_ids`, gained `objectives_worked text[]`, `is_custom_program`,
  `custom_program_name`, `custom_notes`.
- **`objectives_worked` stores LABELS, not uuids.** The exporter was already
  resolving ids back to names on every read, and a label snapshot survives an
  objective being renamed or retired later — which an id would not.
- `submit_class_feedback()` was **dropped and recreated**, not replaced. Its
  parameter list changed, and `create or replace` would have left the old
  version sitting there as an overload for the deployed client to keep calling.
  Verified afterwards: exactly one copy of the function exists.
- `pillar_category` is read nowhere now. The column stays on `program_topics`
  as a loading artefact — it is how the rows arrived, and the names disagree
  across programs anyway (Music Production's single `Objectives` versus the
  other six's four PRD pillars). Ignoring it is what makes that inert.

### The invariants are enforced three times, on purpose

Spec §5 — `objectives_worked` never populated alongside a non-null
`custom_notes`, and switching program clears the other half — lives in:

1. `buildObjectivePayload()` (`src/lib/feedback/objectives.ts`), pure and
   unit-tested in `tests/feedback-objectives.test.ts`;
2. the server action, which re-runs it rather than trusting the form's hidden
   inputs, so a hand-crafted POST carrying both halves is normalised to one;
3. a `feedback_objectives_xor_custom` CHECK constraint, verified live to reject
   a row carrying both.

The form clears both halves on every toggle rather than hiding one, and only
the chosen half is ever mounted — so the other is not merely blanked, it is
absent from the POST.

### The sheet exporter followed, and the column order held

`feedback_for_sheet()` reads `objectives_worked` directly (no lookup left) and
gained `custom_program` + `custom_notes` **at the END**. Verified live: 31
output columns, in exactly the order the TypeScript expects.

`focus_pillar` **stays at position 14 returning null forever.** Deleting it
would slide five columns of history sideways in a spreadsheet that already
holds data. Its header is now "Focus pillar (retired)".

Two things worth knowing for the next schema change:

- The route and the by-hand script kept **identical private copies** of the
  column list. They are now one module, `src/lib/google/feedback-sheet-columns.ts`,
  which also throws at import time if COLUMNS and HEADER fall out of step. That
  pair would have drifted on the first change and corrupted the sheet quietly.
- **`ensureHeader` only wrote a header into an empty sheet**, so the two new
  columns would have been appended with no headings at all. It now also widens
  a header that is shorter than the export — never narrower, never reordered,
  so nothing historic moves.

### Not verified in a browser

Reaching `/feedback/[sessionId]` needs a teacher with an open owed session, and
manufacturing one on production would trip the auto-clockout sweep, the stuck-
feedback detector and the notification queue. Typecheck, lint, build and 149
unit tests pass.

### How to test it

Already verified for you, so do NOT re-test these — they were run against
production on 2026-08-12: the RPC's nine validation rules (two objectives
accepted; zero rejected; another program's objective rejected; duplicates and
padding collapsed; double submission rejected; the Other path; both halves at
once dropping the objectives; Other without a description rejected; another
teacher's session rejected), the exporter's 31-column order, and the
XOR constraint. All test rows were deleted afterwards.

What is left is what a database cannot check — the screen. Sign in as
`emiliomedranomusic@gmail.com` (the teacher-test account, deliberately kept
active for exactly this).

**The feedback form**

1. **Clock in** to a class, then open its feedback form. Drumline or Music
   Production are the best cases — 13 and 30 objectives.
2. **The heading must name the program**: "What was the objective of today's
   Drumline class?", with "Program: Drumline" below it. A wrong name here is a
   `match_patterns` problem, not a form problem.
3. **Submit with nothing ticked** — the button must stay greyed out and say
   "Please choose at least one objective you worked on today."
4. **Tick two or three, submit.** It should accept.
5. **On a fresh class, tap "Not this one?"** The checkboxes must vanish and two
   text fields appear. **Then tap "Use the detected program" and check the
   objectives you had ticked are gone.** This is the single most important
   check on the page — it is the invariant that stops one program's answers
   being filed under another's.
6. **Submit through the escape hatch.** Both fields are required; leaving
   either blank must keep Submit greyed out.
7. **Open the resulting ticket** (submit one with an issue) and confirm the
   "From their feedback" block lists the objectives.

**The spreadsheet** — the part with no undo

8. After `sheet-sync-2min` fires (or run `npm run sync:sheet`), open the sheet
   and **compare a new row against one written before this change**. Every
   column to the left of "Objectives worked" must still line up. Two new
   columns should have appeared on the far right: "Other program
   (teacher-named)" and "Other program — what they worked on". "Objectives
   worked" holds comma-separated labels, never uuids. "Focus pillar (retired)"
   is blank from now on and that is correct.

**The schools and the roster**

9. **Lehrman Community Day School**: open `/lists` and confirm the pin sits on
   the campus at 727 (77th St, Miami Beach). If a teacher there cannot clock
   in, the pin is wrong — say so rather than widening the geofence.
10. **Linda Lentin K-8** should show a calendar. It has 0 events until YMU
    finishes loading the 2026-27 schedule into Google; that is expected, not a
    failure.
11. **Kennedy, Oak Grove and Mandarin Lakes must NOT appear** anywhere in
    Lists, Schedules or Reports.
12. **Teachers**: `/users` should show **49 active, 9 archived**. Spot-check
    that Lilia Hernandez and David Maden exist and that Jose Heredia's email
    reads `jherediaymu@gmail.com`.

---

## 🟡 OPEN — waiting on YMU

- **The class-code legend + an updated CSV** of schools, regions, teachers,
  emails and phones. Regions have changed for some schools. Program
  `match_patterns` are DATA, not code — a legend arrives as one UPDATE, no
  migration and no deploy.
- **Mentors are a separate user type**, with their own clock-in and a different
  form. Explicitly deferred; do not model it yet.
- **Lehrman Community Day School still has no coordinates**, so nobody can
  clock in there. Set them by hand on `/lists`.
- **Linda Lentin K-8 still has no Google calendar.** YMU confirmed the school
  runs, so the calendar is owed rather than the row being wrong.

### ✅ Configuration is COMPLETE (verified 2026-08-12 19:58 UTC)

All seven pg_cron jobs are live and returning HTTP 200: `check-closeout-1min`,
`late-detect-1min`, `notify-dispatch-1min`, `calendar-sync-5min`,
`auto-clockout-5min`, `ticket-sla-15min`, `sheet-sync-2min`. Verified through
`net._http_response`, not `cron.job_run_details` — pg_net is asynchronous, so
"succeeded" there only means the request was queued.

Nothing further is owed on Vercel, Supabase or the Google Cloud console.

<details><summary>Original setup steps, kept for reference</summary>

`SHEET_SYNC_SECRET` and `FEEDBACK_SHEET_ID` are set in Vercel. Once it
redeploys, schedule the mirror:

```sql
select vault.create_secret('<SHEET_SYNC_SECRET value>', 'sheet_sync_secret');
select cron.schedule('sheet-sync-2min', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://ymu-a-navy.vercel.app/api/sheet-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sheet-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_sync_secret')
    ),
    body := '{}'::jsonb
  );
$$);
```

</details>

`npm run sync:sheet` still works for an on-demand catch-up.

---

## ✅ Done 2026-08-12 (late session)

**The Google Sheet mirror is live and verified** — 7 rows written to
"YMU — Feedback Results 2026-27". Two things stood in the way and neither was
the code: the Sheets API was switched off on the Cloud project, and the tab was
called "Sheet1" rather than the configured "Feedback" (a 400 that talks about
range parsing and never mentions tab names). The exporter now asks the
spreadsheet which tabs exist, so the tab can be renamed freely.

The sheet carries **every answer**, not a summary: teacher name/email/phone,
school, region, the accountable Regional Manager, class title and time,
program, engagement, objectives (resolved to labels, not uuids), open notes,
quarter-goal answer, whether an issue was raised, its category/type/urgency,
**what the teacher actually wrote**, ticket number/status/owner/root cause, and
clock-in status/time/origin.

Two ways to run it: `npm run sync:sheet` by hand, or `POST /api/sheet-sync`
with the shared-secret header, which is what pg_cron will call. It is a Next
route rather than an Edge Function so the Google JWT code is reused rather than
duplicated.

**GPS re-checks moved to +15/30/45** (from +5/10/15/20/25). Five samples in the
first 25 minutes told us nothing the first didn't; YMU classes run 60-80
minutes, so three checks across 45 cover the class instead of clustering at its
start.

**Clock-in is same-day only.** A teacher with classes today and tomorrow could
clock into tomorrow's today. Fixed in `clock_in()` itself, not just the UI —
the offline queue reaches that function directly.

**The Clock out button is gone.** Since 0021 `hours_worked` has been the
scheduled duration, so clocking out never affected pay or reporting; it only
marked "still in class", which `clock_in()` and the cron sweep already handle.

**Verified still working after all of the above:** offline clock-in (queued
with the real tap time, replayed on reconnect, idempotent on retry, geofence
re-validated server-side) and the GPS re-check chain.

---

## ✅ Phase 5 complete 2026-08-12: SLA engine, agent metrics, root-cause report

Migration `0031` closes the last of the PRD's ticketing scope. Applied to
production and verified against real rows.

**The clocks run and pause.** `ticket_sla` is a `security_invoker` view that
computes FRT, TTR, Effective Resolution Time and an on_track/warning/breached
verdict in SQL — PRD 4.3 requires an agent and an Admin to see identical
numbers for the same ticket, and two implementations drift the moment one is
edited. Targets: Urgent 4h, High 24h, Normal 72h; warning starts at 75%.

**Pausing needed a second column.** `sla_paused_minutes` existed but nothing
incremented it, and it alone can only report a pause AFTER it ends — so a
ticket sitting in Pending_Teacher right now would report zero and look
neglected. `sla_paused_since` fixes that. Verified: a 5h-old Urgent ticket
reads `breached`; after 3h of pause the same ticket reads `on_track`
(300 − 180 = 120 minutes against a 240-minute target).

**A teacher's reply resumes the clock automatically.** A trigger on
ticket_messages moves Pending_Teacher back to In_Progress and banks the pause.
Without it the pause would keep accruing overnight and quietly flatter the
agent's numbers.

**The 24-hour sweep escalates rather than nags.** `detect_unanswered_tickets()`
notifies the assignee AND the Academic Manager, once per ticket — the queue's
own uniqueness only covers the three reminder types, so the `not exists` guard
is what stops an hourly re-nag. Verified: second pass returns 0.

Scheduled as **`ticket-sla-15min`, calling the function directly as SQL**, not
over HTTP. It only writes notification_queue rows, so pg_cron can invoke it
without an Edge Function, a shared secret, or anything for YMU to configure.

**New surfaces:** `/tickets` gains an Overdue tab with a count badge and SLA
badges on each card (the stripe follows the SLA once late, not the priority —
a Normal ticket three days past target matters more than an Urgent one raised
ten minutes ago). `/tickets/insights` carries PRD 4.4 and 4.5: the manager's
own queue, 7/30/90-day response and resolution averages, SLA compliance,
weekly volume, and the root-cause counts that should shape Summer PD.

### Cron state — all six jobs live

`check-closeout-1min`, `late-detect-1min`, `notify-dispatch-1min`,
`calendar-sync-5min`, `auto-clockout-5min`, `ticket-sla-15min`.
auto-clockout was confirmed end-to-end: a real POST returned
`{"clocked_out":1}`.

`stuck-session-detect` remains undeployed and unscheduled — it predates 0026
and its meaning changed there; decide whether it is still wanted before
reviving it.

---

## ✅ ANSWERED 2026-08-12 — the four schools, and the two roster questions

YMU answered every one. Applied to production the same day.

| School | Answer | What was done |
|---|---|---|
| John F. Kennedy MS | does not run | app row **deleted** |
| Oak Grove ES | does not run | app row **deleted** |
| Mandarin Lakes K-8 | does not run | `calendar_sync_issues` entry resolved |
| Linda Lentin K-8 | **runs** | row kept; its Google calendar is still owed |

Both deletions were checked first, not assumed: every FK into `schools` is
`ON DELETE SET NULL`, so a dependent row would have been silently orphaned
rather than blocking the delete. Both schools had zero calendar events,
sessions, GPS checks, flags, clock-in attempts, tickets and feedback. Their
full rows are in this session's transcript if either needs recreating.

Roster: **111 → 110 school rows**. Exactly one real school now has no calendar
(Lentin) and exactly one has no coordinates (Lehrman).

The two roster questions:

- **Lehrman Community Day School runs**, region **east** — and it is now
  geocoded: `25.8623336, -80.126036`, 200 m geofence, `geocode_source =
  osm_name_match`. See the section below for why every address geocoder failed
  on it.
- **"Highland Oaks Senior High School" was a roster typo.** YMU confirmed it is
  Highland Oaks **Middle** School, which already exists in the app with its
  calendar and 19 events. The review CSV row stays at `action=defer` with the
  answer recorded in its note, so `--apply` can never create it.

### Why Lehrman defeated every address geocoder (solved 2026-08-12)

Census and Nominatim were both tried on "727 Lehrman Dr, Miami Beach, FL
33141", on the street alone, and on the school name — six queries, all empty.
The address is not the problem the way it looked.

**Lehrman Dr is the campus's private drive and does not exist as a routable
street** in OSM or the Census TIGER data. But the school itself is in OSM — as
`Lehnman Community Day School`, with an `n` where the `r` belongs, which is why
every name search missed it too. Photon's fuzzier matching found it where
Nominatim's did not.

Confirmed rather than assumed, because a wrong geofence silently locks a whole
school's teachers out of clocking in — the same failure mode as the
Hialeah/Homestead mis-pin. Reverse-geocoding the point returns **house number
727** and **postcode 33141**, both matching the roster address exactly, on
77th Street. A second independent hit ("Lehrman Day School-Early Childhood
Center") sits **44 m away**, well inside the 200 m geofence. The third OSM hit,
"Lehrman Day School of Temple Emanu-el", is in 33139 on Washington Ave — a
different South Beach campus, correctly rejected.

Worth remembering for the next unresolvable address: try the **place name in
Photon** before concluding an address does not exist. A private drive with a
misspelt POI beats both national geocoders.

Still unexplained: YMU expected **105 calendars and 105 schools**. Reality is
109 school calendars in Google and 110 school rows. Neither side is 105, so
the number came from somewhere else — worth tracing before trusting it.

---

## 🟡 Manager alerts are push-only — no email fallback (noted 2026-08-12)

`gps_out_of_fence`, `late_clock_in` and `feedback_stuck` are absent from
`EMAIL_ELIGIBLE_TYPES` (`dispatch-logic.ts`), so a Regional Manager who has
never subscribed a device to Web Push receives **nothing at all** for any of
them. They also have no entry in `NOTIFICATION_TYPE_TO_PREFERENCE`, so there is
no Settings toggle either way.

The original brief scoped email to "schedule changes, cancellations, and
clock-out reminders only", which is why it is this way. Left as-is rather than
changed quietly — adding three types to the email path is a product decision,
and the Resend free tier is capped at 100/day, which the cap logic in
`planDispatch` already tracks.

Migration 0027 made the push itself carry the full detail, so the content gap
is closed; this is only about reach.

---

## ✅ Done 2026-08-12: all 109 school calendars discovered, 108 of 111 schools pinned

Three of the four blockers below are closed. What actually fixed it:

1. `scripts/apps-script/share-and-list-calendars.gs`, run from the calendar-
   owning account, granted the service account read access to all 110 owned
   calendars and dumped their ids.
2. `scripts/subscribe-calendars.ts` subscribed them (109 of 110 — one
   transient `fetch failed`, picked up on the next run).
3. The `calendar-sync-5min` cron then ran the real sync **on its own**. No
   manual `npm run sync:calendar` was ever needed.

Google went 113 → 110 calendars once YMU deleted the three duplicate pairs.

### A calendar was pinned to the WRONG school, and nothing could have shown it

The sync pinned **"Hialeah Senior High" to Homestead Senior High's calendar** —
two real schools about 30 miles apart. pg_trgm rated the names 0.67, over the
0.5 threshold, with no runner-up close enough to trip the ambiguity margin, so
it auto-matched confidently. Hialeah's teachers would have failed the geofence
at their own school.

The in-app queue lists calendars that **failed** to match; a confident wrong
match is invisible there by construction. It only surfaced by cross-checking
all 106 pins against each calendar's own name in Google.

That check now lives in `npm run calendar:coverage` as `pin_name_mismatch`,
plus `pin_calendar_missing` for a pin whose calendar was deleted or un-shared
(which silently stops syncing — Dr. William Chapman was in exactly that state).
Both are reported, never auto-corrected: six current mismatches are legitimate
spelling variants, e.g. "Carrie P. Meek" pinned to "Carrie P. Meek/Westview
K-8".

`classifyDiscoveredCalendar` also gained a school-level guard. **It would not
have caught Hialeah/Homestead** — both are high schools — and the test says so
explicitly. What it catches is the family-name collision Miami-Dade creates at
nearly every site (Homestead Senior High vs Homestead Middle School), which
scores high on trigram similarity and differs only in the one token that can
never be a spelling variant.

### Data corrections applied directly to production

Hialeah and Homestead re-pinned to their own calendars; Dr. William Chapman
moved onto its surviving twin; John A. Ferguson linked (the fuzzy match had
left it ambiguous); five stale issues resolved. All 108 pins verified one by
one afterwards.

### Still open from the 2026-08-11 blocker list

**Only 8 of 111 schools have future classes.** Confirmed by YMU on 2026-08-12
as expected — the 2026-27 schedule is still being loaded into Google. Re-check
`select count(distinct school_id) from calendar_events where start_at >= now()`
once loading finishes.

**The 500 classes owned by `pedrodiazvaldes@gmail.com`** at Carol City Middle
and Madison Middle are the boss's test events, per YMU. They will be deleted.
Re-run the sync afterwards or they linger in the app as real classes. When the
real schedule lands, the attendee email on each event must exactly match the
teacher's app login email — `loadTeachers` matches case-insensitively but
otherwise exactly (`supabase/functions/calendar-sync/sync.ts:123-146`).

---

## ✅ Done 2026-08-11: pilot data wiped, roster completed to 111 schools

- Migration `0025_reset_pilot_data.sql` cleared `attendance_sessions` (85),
  `gps_checks` (425), `flags` (168) and `notification_queue` (712). Schools,
  calendar events, school years and accounts untouched.
- **"Seed Test School" was squatting on a real school's calendar.** The QA
  fixture (100 km geofence, from `scripts/seed-test-data.ts`) had fuzzy-matched
  and pinned SEED School of Miami's calendar, and had been syncing that
  school's events ever since. Converted in place rather than deleted, so the
  pin and the synced events survive; the 100 km hole is closed.
- Roster grew 73 → **111 schools** via the new `npm run import:schools`.
  **The `west` region went from 0 schools to 14** — the single largest gap.
- Fixed a long-standing typo: "Archola Lake" → "Arcola Lake".
- One school still has no coordinates and therefore cannot be clocked into:
  **Lehrman Community Day School** (727 Lehrman Dr, Miami Beach) — neither
  Census nor Nominatim resolves that address. Set it by hand on `/lists`.
- One roster row deferred, not created: **"Highland Oaks Senior High School"**
  shares an address with the existing Highland Oaks Middle School and MDCPS
  lists no such senior high. Probably a roster typo — confirm before adding.

### The importer is two-step on purpose

`npm run import:schools` writes `school-import-review.csv` and stops. Nothing
touches the database until a human resolves the `REVIEW` rows and re-runs with
`IMPORT_ALLOW=1 ... --apply`.

That is not ceremony. Name-only fuzzy matching on this roster paired
"Homestead Senior High" with "Homestead Middle School" and "Redondo
Elementary" with "Redland Elementary" — different schools that would have been
silently merged, each inheriting the other's geofence, breaking clock-in for
real teachers. Two guards cut the ambiguous set from 14 rows to 1:

- **Level conflict**: `HS`/`MS`/`ES`/`K8` tokens that disagree can never match,
  however similar the rest of the name.
- **Street address**: same street number + street name means the same site
  regardless of the name. This is what caught "Carie P. Meek/Westview K-8" ≙
  "Carrie P. Meek" and "Dr. Henry Mack / West Little River K-8" ≙ "Little River
  K-8", which no name matcher would ever reconcile.

## ✅ Built 2026-08-12 (migration 0026, NOT yet applied): the 24-hour feedback window

Requested 2026-07-28, re-requested and built 2026-08-12. Answers every open
question the original note listed.

**The problem**: `clock_out_at IS NULL` meant three things at once — still in
class, feedback owed, and feedback blocking the next clock-in. Back-to-back
classes made that fuse fire when it shouldn't: a teacher physically cannot stop
and fill a form before the next class starts.

**The split**, and the whole change in three lines:

```
still in class     -> clock_out_at IS NULL          (unchanged meaning)
feedback owed      -> feedback_settled_at IS NULL   (new, generated column)
feedback BLOCKING  -> feedback_settled_at IS NULL AND feedback_due_at < now()
```

Decisions the original note left open, now settled:

- **The clock starts at the class's scheduled END**, snapshotted at clock-in as
  `scheduled_end_at` so a later calendar re-sync cannot move a teacher's
  deadline. A class with no scheduled end gets no deadline and never blocks.
- **All overdue items block, and all must be cleared.** "Only the oldest
  blocks" produces a rolling wall: clear one, tap Clock in, blocked by the next.
- **The teacher-facing list is `/feedback`** — the "like flags, but for
  teachers" surface, with `/feedback/[sessionId]` per class. `ROUTE_ROLES`
  matches by prefix, so `roles.ts` needed no change.
- **Clock-out happens three ways**: `clock_in()` closes any still-open session
  in the same transaction as the insert (this is what makes back-to-back
  classes work, and makes the partial unique index collision structurally
  impossible); an explicit Clock out button; and a cron sweep
  (`auto_clock_out_ended_sessions`) for the teacher who walks away. None
  distorts hours — `attendance_period_rows.hours_worked` has been the
  *scheduled* duration since 0021.
- **Both feedback providers keep working.** Their idempotency guards moved from
  `clock_out_at` to their own feedback columns, and this is load-bearing: with
  auto clock-out, `clock_out_at` is routinely non-null when a genuine
  first-time submission arrives, and the old guard would swallow it and return
  success — feedback lost, no error anywhere.

### ✅ Migrations 0026 and 0027 APPLIED 2026-08-12

Applied to production via the Supabase MCP, in four verified chunks for 0026
plus one for 0027. Verified after the fact: four new columns on
attendance_sessions (feedback_settled_at reporting `is_generated = ALWAYS`),
six new functions, the clock_in_attempts table and the clock_in_result type,
and the grant matrix — attempt_clock_in and clock_out executable by
`authenticated`, auto_clock_out_ended_sessions and
manager_notification_payload service_role only, so a teacher cannot read
another teacher's phone through the payload helper.

Safe to apply ahead of the code because the DB change is strictly more
permissive and the old client cannot reach it: the deployed /clocking page
swaps itself for the feedback form whenever a session is open, so the relaxed
gate is unreachable until the new UI ships. The backfill was a no-op — zero
attendance_sessions rows after the 0025 reset.

`auto-clockout` is **deployed** (verify_jwt false, shared-secret header, same
shape as late-detect) and confirmed failing closed: it returns
`{"error":"Auto clock-out is not configured."}` until the secret exists.

### ⚠️ The auto-clockout cron is deliberately NOT scheduled yet

Scheduling it before the web code deploys reintroduces exactly the bug the
migration was careful to avoid. The deployed feedback form still polls
`clock_out_at` to decide when to render "Feedback received"; once cron starts
closing sessions, that poll false-positives and tells a teacher their unsent
feedback arrived, then clears their draft. The fixed poll (reading the feedback
columns) is on the `development` branch, undeployed.

So the remaining order is: **push and deploy the web code first**, then
schedule the cron. Steps, in order:

1. Supabase dashboard → Project Settings → Edge Functions → Secrets → add
   `AUTO_CLOCKOUT_SECRET`.
2. SQL editor, storing the SAME value so the cron can read it back:
   `select vault.create_secret('<value>', 'auto_clockout_secret');`
3. Schedule it (same shape as `calendar-sync-5min`):

```sql
select cron.schedule('auto-clockout-5min', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://vgyogyojxlvhiwujidhy.supabase.co/functions/v1/auto-clockout',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-auto-clockout-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'auto_clockout_secret')
    ),
    body := '{}'::jsonb
  );
$$);
```

Rotate note, same trap as `check_closeout_secret`: the cron reads from Vault
and the function reads its own Edge secret, so rotating one without the other
breaks it silently.

### Also owed at deploy time

- ~~Redeploy `notify-dispatch`~~ — **done 2026-08-12** (version 18). Confirmed
  live: `net._http_response` shows it returning 200 with the expected body on
  the 1-minute cron. That also proves the cross-boundary import survives the
  deployed Deno runtime — `dispatch-logic.ts` pulls `APP_TIME_ZONE` from
  `src/lib/format/datetime.ts`, and a failed import would have boot-errored the
  whole function rather than degrading quietly.
- `stuck-session-detect` remains **undeployed and unscheduled**, and its
  meaning changed in 0026: `p_stuck_after_hours` is now a grace period *after*
  the deadline, not a window measured from clock-in. Default 0 means "escalate
  the moment the 24h window lapses", which is the same moment clock-in starts
  blocking.

## ✅ Fixed: class times showed +4h wrong on server-rendered screens (2026-07-28)

Live-reported during the Relay: a teacher whose class was 12:30–2:30 PM saw
4:30–6:30 PM on the **clock-in screen** (and the event-detail page, Flags,
Dashboard). The Schedules **list** was correct, which is the tell.

Root cause: every human-readable time was formatted with
`Intl.DateTimeFormat(undefined, …)` — no `timeZone` — which uses the
*runtime's* zone. A React Server Component's runtime is Vercel, which runs in
**UTC**, so a 12:30 PM Eastern class (stored 16:30 UTC) rendered "4:30 PM".
The Schedules list looked fine only because it's a Client Component that ran
on the teacher's Miami phone. NOT a Google Calendar problem and NOT a data
problem — the stored `start_at` (UTC) and the stored on_time/late status were
always correct; only the display strings were wrong.

Fix: new `src/lib/format/datetime.ts` pins all clock-time/date rendering to
`America/New_York` (YMU is Miami-only; the IANA zone handles EDT/EST DST
automatically — do not use a fixed offset). All display sites converted.
Verified under `TZ=UTC`: old → "4:30 PM", new → "12:30 PM – 2:30 PM".

Split across two commits by deploy-safety:
- `2ad1c92` — the teacher-facing surfaces with NO DB dependency (Clocking,
  Schedules, feedback line, search). **Safe to push immediately, no
  migration needed.**
- `3f8153e` — the rest (Dashboard/Flags/Home), bundled with the two features
  below because they touch the same files.

Any stale Flag cards from BEFORE the schedule was corrected in Google
Calendar will still show their old (wrong) frozen `scheduled_start_at` — those
are obsolete; just "Mark resolved" them.

## ✅ Migrations 0023 + 0024 applied — safe to deploy everything (2026-07-28)

The user applied both migrations via the Supabase SQL editor. The
`dal.ts`-selects-`is_app_admin` deploy hazard is therefore cleared — the
whole branch (timezone fix + both features) can now ship in a single
`git push origin main`, no ordering constraint left.

**Two new features these commits/migrations add:**
1. **Manager attendance correction** (migration 0023): RM/OM/CPO can edit a
   clock-in's status/time or record a class a teacher gave but never clocked
   in for. Requires the manager to re-enter their OWN password; writes an
   audit trail (`admin_edited_by/at/reason`); RM is region-scoped. On Flags +
   Dashboard. This finally closes the long-standing "no way to fix
   attendance" gap the paper backup was covering.
2. **In-app feedback button** (migration 0024): global "report a problem"
   button (message + optional screenshot → private `app-feedback` Storage
   bucket) for every role; inbox at `/app-feedback` for OM/CPO + anyone with
   the new `profiles.is_app_admin` flag (seeded to `region3@ymu.org`).

## 🔴 Signup / forgot-password / any auth email is broken — two issues, one fixed

**Issue 1 (fixed by the user, 2026-07-28):** `POST /signup` was returning 500
with `"error":"dial tcp: lookup smtp.resend.com,: no such host"` — a stray
trailing comma in the SMTP host configured in the Supabase dashboard
(Project Settings → Auth → SMTP Settings). The user removed the comma.

**Issue 2 (found immediately after, still open):** the very next signup
attempt now gets past DNS and fails at Resend itself:
`"error":"gomail: could not send email 1: 550 \"The ymu.org domain is not
verified. Please, add and verify your domain on
https://resend.com/domains\""`. Resend requires the **sending domain**
(`ymu.org`, whatever "from" address the SMTP config uses) to be verified via
DNS records (SPF/DKIM/DMARC — Resend generates the exact records) before it
will relay mail for that domain at all. This was already a known owed item
from earlier phases ("Resend domain verification" in HANDOFF.md's old
punch list) — not a new regression, just now confirmed as the actual
current blocker.

**Fix (needs whoever manages `ymu.org`'s DNS, not fixable from this repo):**
1. In the Resend dashboard → Domains, add `ymu.org` (or whichever domain the
   "from" address uses).
2. Resend gives a handful of DNS records (TXT for SPF, CNAME/TXT for DKIM,
   optionally a DMARC TXT record) — add those at the DNS provider that hosts
   `ymu.org`'s records.
3. Wait for DNS propagation, then click "Verify" in Resend's dashboard.
4. Re-test signup/forgot-password once verified.

**Until that's fixed**, for the Relay week: don't rely on in-app signup or
"Forgot password?" working. Create/update accounts directly via
`scripts/onboard-real-users.ts`-style admin scripts (service-role key), and
edit phone numbers etc. the same way (or directly in the `profiles` table)
rather than expecting teachers to self-serve.

**Also flagged by the user**: there's currently no "change my password" option
inside Settings while already signed in — only the recovery-email flow
(`/reset-password` → email link → `/update-password`), which itself needs
the SMTP fix above to work at all. A future phase could add a simple
"change password" action in Settings (re-auth with current password, then
`supabase.auth.updateUser({ password })`) — not built, only noted.

## ✅ Clean-slate wipe + real Relay-week onboarding executed (2026-07-28)

Executed the plan from the previous entry, once the user's final test pass
(Safari redirect loop, now fixed — see the DECISIONS.md entry) came back
clean. Ran via a new script, `scripts/onboard-real-users.ts`
(`ONBOARD_ALLOW=1 npm run onboard:real`, same shape/conventions as
`seed-test-data.ts`):

1. **Deleted** all 10 test/seed accounts (the 4 `*@ymu.test` seed accounts,
   2 ad hoc manual-test teacher accounts, 2 leftover `events-rls-*` test
   fixtures, and 2 other stray test teacher accounts) — kept only
   `region3@ymu.org` (Emilio Medrano, Central RM) and
   `programs@youngmusiciansunite.org` (YMU Programs, CPO).
2. **Created** two new regional managers: `region1@ymu.org` (Eric Levy,
   North) and `region2@ymu.org` (Julian Bermudez, South). Operations Manager
   intentionally not created yet.
3. **Created 48 teacher accounts** — everyone confirmed to (a) have a Gmail
   address and (b) appear on this week's 3-day Relay check-in roster
   (`Teacher Relay Schedules.xlsx`, cross-referenced against `YMU Teacher
   Candidates - Sheet1.csv`). Shared password `ymu12345` for all of them —
   teachers should change it via "Forgot password?" on first login (there's
   no in-app "change my password while signed in" flow currently, only the
   recovery-email one).
4. **Two Relay-roster people have NO record in the candidates CSV at all**
   (no email on file) and **5 more have an email but it's not Gmail** (2 of
   those 5 are ALSO marked "Accepted Offer = FALSE" in the CSV despite being
   on this week's roster — likely a stale CSV, flagged to the user, not
   independently verified). None of those 7 have accounts yet. Full names
   and the CSV/roster discrepancy detail were handed to the user directly
   (not restated here to avoid duplicating contact info across documents).
5. **`profiles.phone`** filled in from the CSV where present; 26 of the 48
   created teachers have no phone on file (also handed to the user
   directly, to ask in person at the Relay).

**Not committed to git**: `scripts/onboard-real-users.ts` (and the
`package.json` line that references it) contain real teachers' names,
emails, and phone numbers as literal source — left uncommitted pending the
user confirming they're fine with that contact info living permanently in
git history. Ask before committing if picking this back up.

**Still owed / found while doing this:**
- **No role can currently edit an existing clock-in's late/on-time status or
  timestamp** — confirmed by reading every function that writes to
  `attendance_sessions` (`clock_in`, `close_session_from_zoho`,
  `admin_close_stuck_session` — the last is OM/CPO-only and only force-closes
  a stuck *open* session via `clock_out_at`/`admin_closed_*`, it doesn't touch
  `clock_in_status`/`clock_in_at`). The user is running a **paper backup**
  check-in/check-out log for the Relay week specifically because of this, and
  said that's the source of truth if it ever disagrees with the app. If a
  manager-side correction UI is wanted later, it needs a new RPC (server-side
  guarded, not a raw grant) — not built, only discussed.
- **All of this week's Relay attendance/feedback data (clock-ins, clock-outs,
  reports) must be wiped after this week**, before the official classes
  start mid/end of August, so real teachers start with a clean slate. Not
  scheduled yet — revisit after the Relay week wraps.
- **The whole app must be English regardless of role** (user confirmed) —
  found and fixed one leftover Spanish string (the "new version available"
  update banner, predates this session — see DECISIONS.md). Grepped the
  entire `src/` tree for Spanish afterward; nothing else found.

## ✅ Google Stitch + Base44 design rework applied app-wide (2026-07-28)

User exported a Google Stitch design ("YMU Tempo" — Material 3, Inter,
Material Symbols) as a zip (`code.html` + `screen.png` per screen + a
`DESIGN.md` token spec) and shared a Base44 reference app
(`https://ymu-connect-flow.base44.app/teacher`) for a second opinion. Both
were applied to the real app across two commits:

**Commit `03ad3a8`** — full Material 3 token system ported into
`src/app/globals.css` (surface/primary/tertiary/error/warning containers,
light + dark), Inter + Material Symbols loaded in the root layout, a new
mobile bottom-nav component, and every screen restyled to match (Home,
Clocking, Feedback, Schedules, Dashboard, Lists/Directory, Flags, Reports,
Settings, Team/Users, all auth screens, shared widgets). **Visual-only** —
no logic, data flow, routes, or form fields changed; done via 8 parallel
subagents each restyling an independent file group off a shared conversion
guide, then verified with `tsc`/`eslint`/route-compile checks (no visual
diff tool available in this environment, but Login/Signup were screenshotted
directly and match the Stitch mockup).

**Commit `78f9973`** — refinements per user feedback after reviewing Base44
side-by-side:
- **Regional Manager's accent color changed from teal (`#0d9488`) to violet
  (`#7c3aed`)** — teal read as "success" (already used for on-time/in-zone
  everywhere else) and didn't fit the indigo/violet palette both references
  use. OM (amber) and CPO (rose) were left as-is.
- Adopted from Base44: a contextual Home greeting ("You teach X at Y"), a
  gradient indigo→violet "Next up" hero card with a white Clock-in pill
  (teacher Home, shown when there's a next class and no open session), a
  "This week" stat row (Hours/On-time/Attendance, reusing the same
  `bucketReportRows` aggregate Reports uses), and an M3 pill highlight
  behind the active bottom-nav tab.

**Convention change to note for future work**: inline alert/status text
should now use the M3 tokens (`text-error`, `text-tertiary`,
`bg-error-container text-on-error-container`, etc. — see
`src/app/globals.css`'s `@theme inline` block) instead of the old
`text-red-600 dark:text-red-400` / `border-amber-500/40 bg-amber-500/5`
pattern HANDOFF.md's "Conventions to preserve" describes. Any new
screen/component should follow the new tokens, not the old ad-hoc
Tailwind colors.

**Not yet pushed by the agent** — this build environment has no GitHub
credentials (`git push` fails with "could not read Username… Device not
configured" even outside the sandbox); the user pushed `03ad3a8`
themselves, `78f9973` is committed locally and still needs `git push
origin main` run from the user's own terminal.

**QA seed data now exists on the hosted (production) Supabase project**
(user explicitly confirmed running this against `vgyogyojxlvhiwujidhy`,
there is no separate staging project) — `SEED_ALLOW=1 npm run seed:test`
created/updated: `teacher@ymu.test` / `rm@ymu.test` / `om@ymu.test` /
`cpo@ymu.test` (password `YmuTest123!`), a "Seed Test School" (~100 km
geofence so clock-in works without exact GPS), a "Seed Test Year" school
year, and a "Seed Test Class" calendar event. Re-running the script is
idempotent (updates the same fixed rows, never deletes). These test
rows/accounts must be cleaned up as part of the clean-slate wipe below
before real onboarding, since they're currently visible to real
managers in Lists/Schedules/Reports (clearly named "Seed"/"Test").

## ✅ Calendar-sync cron confirmed running fully on its own (2026-07-28)

Confirmed via `net._http_response`/edge-function logs: `calendar-sync` fired
automatically at `00:15:25`, `00:20:25`, `00:25:25` (exactly every 5 min,
nobody triggered it manually), all 51 calendars synced with `status: 200`
each time. The Edge Function redeploy from the previous session fully fixed
this — no more "I had to trigger it myself" needed.

## 🔴 PENDING (user confirmation needed before executing): clean-slate user wipe + CSV teacher import

Sequencing, per the user (2026-07-28), unchanged in spirit from the earlier
note but now with the follow-on step spelled out — **do NOT execute any of
this until the user explicitly says the final test pass succeeded**:

1. User is about to do a final manual test pass: Google Calendar sync (a real
   event, a real school) and the Resend email path (notifications/reminders),
   using the seeded `teacher@ymu.test` account and the "Seed Test Class"
   event from the redesign work above.
2. **Only if that passes**, wipe every profile except the regional manager(s)
   to keep — delete via `supabase.auth.admin.deleteUser(id)` (cascades to
   `profiles` via the FK), NOT a raw `delete from profiles` (would orphan the
   `auth.users` row).
3. **Delete all teacher accounts** (including the seeded `teacher@ymu.test`
   and any real teachers created so far) so onboarding starts clean.
4. **Create additional Regional Manager accounts** (count/emails/regions:
   ask the user when this step is reached — not specified yet).
5. **Bulk-create real teacher accounts from a CSV** the user will provide,
   all sharing one default password (teachers change it themselves after
   first login — standard Supabase `resetPasswordForEmail` flow, already
   built). This needs a small one-off script (similar shape to
   `scripts/seed-test-data.ts`'s account-creation loop, but reading rows from
   a CSV instead of the hardcoded `ACCOUNTS` array) — not written yet.
6. Whatever else turns out to be needed so the app is ready for real use
   "tomorrow" — re-derive the exact list with the user once step 1's test
   results are in, since new gaps may surface during that pass.

**Still-unresolved ambiguity from before** (re-check before executing step 2,
since more accounts may have been added since):
- **Two `cpo`-role profiles exist**: `cpo@ymu.test` ("Seed CPO", a test
  account) and `programs@youngmusiciansunite.org` ("YMU Programs" — looks
  real). Confirm which one to keep.
- **No real `operations_manager` profile exists** — only
  `om@ymu.test` ("Seed Operations Manager", a test account). Confirm
  whether to keep that test OM account as a placeholder, or whether a real
  OM email should be created instead.
- Re-query `select p.*, au.email from profiles p left join auth.users au on
  au.id = p.id` right before executing step 2/3, rather than trusting any
  previously-recorded row count.

**Found a real ambiguity querying current profiles** — needs the user's
answer before running anything:
- **Two `cpo`-role profiles exist**: `cpo@ymu.test` ("Seed CPO", a test
  account) and `programs@youngmusiciansunite.org` ("YMU Programs" — looks
  real). Confirm which one to keep.
- **No real `operations_manager` profile exists** — only
  `om@ymu.test` ("Seed Operations Manager", a test account). Confirm
  whether to keep that test OM account as a placeholder, or whether a real
  OM email should be created instead.
- Full current profile list (12 rows: 2 cpo, 2 regional_manager, 1
  operations_manager, 7 teacher) is in this session's transcript — re-query
  `select p.*, au.email from profiles p left join auth.users au on au.id =
  p.id` before executing, since more test/real accounts may be added before
  this actually runs.

**Execution plan once confirmed** (do NOT run without explicit go-ahead):
delete via `supabase.auth.admin.deleteUser(id)` for each profile to remove
(cascades to `profiles` via the FK) — NOT a raw `delete from profiles`,
which would leave an orphaned `auth.users` row. Do teachers in the same
batch or a separate one, per the user's "test now, wipe teachers later"
sequencing.

## 🟡 Stitch MCP connection — user needs to run this in their OWN terminal

User wants Google Stitch (AI UI design tool) connected for the app redesign
work. Same limitation as the earlier GitHub PAT attempt: this sandbox has no
`claude` CLI binary (`command not found`), so `claude mcp add stitch ...`
cannot be run from here — it must be run in the user's own terminal. Once
added there (project-scoped `.mcp.json`), it may become available in a
running session automatically without a restart — this is exactly what
happened with the Supabase MCP connection earlier this session. Check via
`ToolSearch` for `mcp__stitch__*` tools at the start of a future session
before assuming it isn't connected.

User also wants a **base44** design (another AI app-design tool) reviewed
for inspiration alongside Stitch's output, once they share the link — not
done yet, no link received.

The Google-Stitch design-brief prompt (covering all key screens: login,
teacher home, clocking, feedback form, schedules, reports, manager
dashboard, flags, lists, settings) was already generated and sent to the
user as a file this session — regenerate by reviewing this file's git
history / the session transcript if it's needed again and not saved
locally.

## ✅ Relay feedback form confirmed live in production (2026-07-27)

Live-verified end to end against `https://ymu-a-navy.vercel.app` (commit
`8a6f649`): logged in as a real teacher, `/feedback` rendered the native
relay form (not Zoho), submitted it, session closed correctly. Logged in as
OM, the Dashboard's "PD relay feedback" CSV export returned the correct row.
`FEEDBACK_FORM_PROVIDER=relay` is live and working on Vercel.

**Two real gotchas hit while verifying, for future reference:**
1. **Vercel env var changes need a redeploy.** Setting `FEEDBACK_FORM_PROVIDER`
   in the dashboard does nothing to an already-built deployment — Vercel
   bakes server-only env vars into the function bundle at build time. A
   fresh deploy (new commit, or a manual redeploy of the same commit) is
   required after any env var change, every time.
2. **A stale service-worker on one device can look like the deploy failed.**
   The `sw-update-prompt.tsx` fix (below) makes this self-resolving going
   forward, but on an already-stuck device the fix is still: tap
   "Actualizar" if the banner shows, or fully close and reopen the app.

## ✅ Fixed: the "Actualizar" (update) banner could get stuck forever

**Root cause:** the service worker used `skipWaiting: true` +
`clientsClaim: true` — a new worker took control the instant it installed,
so it never entered the "waiting" state. The banner's only path to reload
was a racy `controllerchange` event + a 4s timeout fallback, which is
exactly the failure mode a teacher hit.

**Fix (`src/app/sw.ts` + `src/components/sw-update-prompt.tsx`):**
`skipWaiting` is now `false` (kept `clientsClaim: true`). Updates land
deterministically in the "waiting" state; the banner detects it (via the
`waiting` event AND an on-mount registration check, so an update that
finished installing before the listener attached is still caught); clicking
"Actualizar" sends `skipWaiting`, waits for the real `controllerchange`,
then reloads once. Verified locally with an actual two-version build/serve
cycle (not simulated): new worker waited correctly, banner showed, click
transitioned v1→v2, banner cleared, and a follow-up check on the now-stable
version produced no phantom banner (confirmed no loop). Safe rollout: a
device currently running the old `skipWaiting:true` code installs this
fix's build as a **waiting** worker and its own (old) banner code already
knows how to apply a waiting worker, so the very next update after this
ships is the last "trust me" update — every one after is the new reliable
flow.

**This matters a lot for the eventual return to Zoho**: whenever the app
next needs pushing to teachers' already-installed devices, this is the
mechanism that gets it there reliably instead of teachers being stuck on a
stale bundle indefinitely.

## ✅ RESOLVED: calendar-sync cron was 401ing because the DEPLOYED Edge Function was stale (not a secret mismatch)

**Root cause (found via the Supabase MCP, 2026-07-27):** the `calendar-sync`
cron had been returning `401 {"error":"Unauthorized."}` every 5 min for days,
and `calendar_sync_state.last_synced_at` was stuck since 2026-07-23. This was
NOT a secret-value mismatch (much time was lost chasing that). The **deployed**
`calendar-sync` Edge Function was an OLD version (v17) that:
1. Authenticated via `Authorization: Bearer <SERVICE_ROLE_KEY>` — but the cron
   sends `x-calendar-sync-secret`, never an `authorization` header, so the
   check failed 100% of the time regardless of any secret value.
2. Was the pre-multi-calendar single-`GOOGLE_CALENDAR_ID` version, not the
   `syncAllCalendars` code that's been in the repo for many phases.

In other words, the repo code and the deployed function had drifted completely
apart — the repo's `supabase/functions/calendar-sync/index.ts` (checks
`x-calendar-sync-secret` via `_shared/secret.ts`, uses `syncAllCalendars`) had
**never actually been deployed**.

**Fix:** redeployed the current repo code as version 18 via the Supabase MCP
`deploy_edge_function` (verify_jwt=false, custom secret auth). Verified live:
one invocation synced 37/40 calendars in seconds with **0 errors**; Little
River K-8 synced 578 active events; `last_synced_at` now advancing. The cron
uses the identical `net.http_post` call, so it now succeeds on its own every
5 minutes. The Vault secret `calendar_sync_secret` and the Edge Function
secret `CALENDAR_SYNC_SECRET` DO match (both `9035fe…9a9b`) — that part was
fine; the broken piece was purely the stale deploy.

**Update — confirmed and fixed (same session):** the other three scheduled
functions (`check-closeout` v17→18, `late-detect` v17→18, `notify-dispatch`
v15→16) were indeed all running pre-hardening-pass code — plain `!==` secret
comparisons instead of `_shared/secret.ts`'s timing-safe `secretsMatch()`,
and `notify-dispatch` was using a plain `select` instead of the atomic
`claim_notification_batch()` RPC (migration `0019`'s fix for double-sends on
overlapping runs). None of this was causing outright failures today (push
notifications were successfully reaching real devices — verified live, see
below), but it was a real latent risk. All three redeployed via the Supabase
MCP and verified with a direct invocation each (200, correct response shape).
**Lesson: this repo has no CI/CD auto-deploy for Edge Functions — a code
change in `supabase/functions/**` does nothing until someone explicitly
deploys it.** Check deployed-vs-repo whenever something in this family
misbehaves; don't assume a deploy happened just because the code was
committed.

## ✅ Verified live: late-teacher push notifications to a Regional Manager actually work

Investigated a report of "I never saw a notification as RM about a late
teacher." Found via direct DB queries (not guessed): 11 historical
`late_clock_in` push attempts to a real RM (`region3@ymu.org` / Emilio
Medrano) between 2026-07-21 and 2026-07-23 show `status: failed` after 5
attempts each — but a fresh one created 2026-07-27 shows `status: sent`,
confirmed delivered. The pipeline (`detect_late_clockins()` →
`notification_queue` → `notify-dispatch` → Web Push) works today; the old
failures predate this session's fixes (VAPID key wiring, the Edge Function
redeploys above) and aren't reproducing now. If a real RM still doesn't
*see* a push, the likely causes are device-side (notification permission
revoked, Do Not Disturb, or push subscribed from a different
browser/session than the one currently open) rather than a code bug —
nothing in the dispatch logic silently drops a `late_clock_in` notification
for a subscribed recipient.

## 🟡 Reports "wrong hours" report — logic verified correct against real data, need the specific example to go further

`attendance_period_rows.hours_worked` (migration `0021`'s fix: credits the
*scheduled* class duration, `end_at - start_at`, once clocked in — not
`clock_out - clock_in`) was checked directly against real production rows:
a 5-minute test class correctly shows `0.083h`, normal 1-hour classes
correctly show `1.0h`. The view and the TypeScript bucketing
(`src/lib/reports/aggregate.ts`) both look correct and match real data in
every case checked. **If a report is showing 7 hours for what should be a
much shorter class, the most likely explanation is that the real Google
Calendar event for that class has the wrong start/end time span** (a
data-entry issue in Google Calendar itself, 7 hours apart), not a code bug
— since the view faithfully reports whatever the calendar event says.
**Next step**: get the specific teacher/class/date that showed 7 hours and
check that exact `calendar_events` row's `start_at`/`end_at` directly.

## 🔴 Auth: signup confirmation emails, confirmation codes, and password reset are unreliable — known root cause, not yet fixed

Real teachers are hitting this now. Root cause was actually already flagged
back in Phase 1 (see DECISIONS.md) and never resolved: **Supabase's default
built-in email sender is used for ALL auth emails** (signup confirmation,
password reset) — it is explicitly not meant for production use, is
rate-limited to a small number of sends per hour project-wide, and is
commonly filtered as spam by real inboxes. `RESEND_API_KEY`/
`RESEND_FROM_EMAIL` already exist and are already used for a *different*
purpose (notify-dispatch's reminder emails) — Supabase Auth's own emails are
a **separate system** that needs its own SMTP configuration and currently
has none.

**The fix is a dashboard-only configuration change, not a code change** (no
tool available here can set it — Auth SMTP settings aren't exposed via the
Supabase MCP's `execute_sql`/`deploy_edge_function`, they're a project-level
Auth setting):
1. Supabase Dashboard → **Authentication → Emails → SMTP Settings** → enable
   custom SMTP.
2. Host: `smtp.resend.com`, Port: `465` (or `587`), Username: `resend`,
   Password: the existing `RESEND_API_KEY` value.
3. Sender email: the existing `RESEND_FROM_EMAIL` (must already be a
   verified domain in the Resend dashboard — it already is, since
   notify-dispatch uses it successfully today).
4. Save, then test: sign up a fresh test account and confirm the
   confirmation email arrives quickly and isn't in spam; test "Forgot
   password" the same way.

**Immediate unblock for this week, independent of the above fix**: bulk-
create accounts for the real teachers directly via the admin API (same
technique `scripts/seed-test-data.ts` already uses — `auth.admin.createUser`
with `email_confirm: true` set directly, bypassing the confirmation email
entirely, plus writing `profiles.role` **and** the JWT `app_metadata.app_role`
claim together so there's no stale-JWT relogin trap). Give each teacher a
temporary password that works starting today; once the SMTP fix above is
live, "Forgot password" will work for real self-service resets going
forward. Needs a name+email list from the user to execute.

## 🟢 All 3 remaining scheduled Edge Functions redeployed (2026-07-27)

`check-closeout` (v17→18), `late-detect` (v17→18), `notify-dispatch`
(v15→16) all redeployed with current repo code via the Supabase MCP, closing
the drift gap found while investigating the notification issue above. All
three verified with a direct authenticated invocation post-deploy (200,
correct response shape: `{"closed":1}`, `{"flagged":0}`,
`{"enqueued":0,"processed":0,...}`). No functional regressions — these were
already working, just running stale/less-hardened code.



## 🔴 NEWEST: PD-week native "relay" feedback form (branch `pd-week-google-form-feedback`) — code done, migration owed

The Zoho feedback investigation is paused, not resolved (see `BUGS.md`).
Meanwhile YMU is running a professional-development week for teachers and
wants the app's clocking flow, but with a **different feedback form for this
week only**. First attempt was pointing the app at a real external Google
Form ("YMU Teacher Relays – Teacher Self-Reflection Form",
`https://forms.gle/pbPnA2URdq33rdiV9`) with an Apps Script relay — **that was
scrapped** (user-directed pivot) in favor of something simpler: a **native
in-app copy of that same form**, filled out directly by the teacher, no
external form/relay/webhook at all. The question set was copied faithfully
by reading the real form's `FB_PUBLIC_LOAD_DATA_` payload directly (not
guessed) — see `supabase/migrations/0022_relay_feedback_close.sql`'s header
comment for the full provenance.

**What was built** (this branch, does not touch any Zoho code or column —
both paths coexist behind an env var):
- `supabase/migrations/0022_relay_feedback_close.sql` — new typed columns on
  `attendance_sessions` (`relay_block`, `relay_program_area`,
  `relay_objective`, `relay_achieved_objective`, `relay_objective_reflection`,
  `relay_engagement_scale`, `relay_challenges text[]`, `relay_pivots`,
  `relay_feedback_submitted_at`) and `close_session_with_relay_feedback()` —
  an **authenticated** RPC (not service-role/webhook-only) that checks
  `auth.uid()` owns the session and closes it in one call, same shape as this
  app's very first, pre-Zoho-rework `clock_out_with_feedback` (0008).
- `src/lib/attendance/relay-feedback.ts` — the exact choice text for every
  dropdown/radio/checkbox question, plus `getFeedbackConfig()` which picks
  Zoho vs the native "relay" form based on `FEEDBACK_FORM_PROVIDER`.
- `src/app/(app)/feedback/relay-feedback-form.tsx` + `actions.ts` — the
  native form (a plain `useActionState` form, no polling needed — the RPC
  closes the session synchronously, then the server action redirects home,
  same as `clockIn()`). Deliberately does **not** ask "Teacher Name" or "Day
  of Session" (the reference form's first two questions) — the app already
  knows both from the authenticated caller and the session's clock-in time,
  matching how the Zoho path already auto-fills school/teacher/date rather
  than re-asking known data.
- `src/app/(app)/feedback/feedback-form.tsx` — when the provider is `relay`,
  renders `RelayFeedbackForm` instead of the Zoho iframe; the Zoho path
  (iframe + offline draft + polling) is completely untouched.
- **"Save it in a spreadsheet" ask**: `/api/relay-feedback/export`
  (OM/CPO-only) + a "PD relay feedback" section on the Manager Dashboard with
  a **Download CSV** link — plain CSV rather than a live Google Sheets sync,
  since this is a one-week form and a CSV opens directly in
  Sheets/Excel/Numbers. If a *live*, always-up-to-date spreadsheet turns out
  to matter, that's a follow-up (would need a Sheets-API-scoped service
  account), not something built here.
- `npm run lint` / `build` / `tsc --noEmit` / `npm run test` all clean.

### Owed before switching `FEEDBACK_FORM_PROVIDER=relay` on

1. **Apply migration `0022`** the same way `0017`–`0021` were applied
   (dashboard SQL editor, or `supabase db push` from a machine with CLI
   access — this sandbox has neither, see item 8 in "Finish Phase 9" below).
2. **Set `FEEDBACK_FORM_PROVIDER=relay`** (`.env.local` for local testing,
   Vercel Production + redeploy for the real deployment) — no other env vars
   needed for this path (no secrets, no external URL).
3. **Test end to end**: log in as a teacher, clock in to any class, go to
   `/feedback` — the native form should render (Relay Block, Program Area,
   objective text, achieved-objective radios, objective reflection, 1–5
   engagement scale, challenge checkboxes, optional pivots). Submit it and
   confirm you're redirected home with no "Feedback required" banner (i.e.
   the session actually closed) and no error.
4. **Test the export**: log in as OM/CPO, open the Manager Dashboard, click
   "Download CSV" under "PD relay feedback" — confirm the submitted row
   appears with the right teacher/school/class/answers.

**To go back to Zoho after this week**: just unset `FEEDBACK_FORM_PROVIDER`
(or set it to `zoho`) and redeploy — no code or migration to revert, the two
paths are fully independent and migration `0022`'s columns simply sit unused.

Where to pick up otherwise. **Migrations `0019` and `0020` are both applied** (the
user confirmed both directly against the hosted project). `0020` fixed a
real bug found during live production testing: a Regional Manager saw
"Unknown teacher" on the dashboard for a correctly-assigned, real teacher —
see "Fix RM teacher visibility" below for the root cause. Also found during
that same live-testing pass:
- Several **production environment variables were never set on
  Vercel/Supabase** (VAPID keys, `ZOHO_FEEDBACK_FORM_URL`, the Auth URL
  Configuration) — user has since set the VAPID keys and
  `ZOHO_FEEDBACK_FORM_URL` and fixed the Auth URL config; see "Finish
  production configuration" below for anything still outstanding.
- **`calendar-sync`'s pg_cron job had never actually been scheduled on the
  hosted project** — confirmed via `select * from cron.job` returning only
  `check-closeout-1min`/`late-detect-1min`/`notify-dispatch-1min`, no
  `calendar-sync` job at all, and `calendar_sync_state.last_synced_at`
  stuck 3 days stale as a result. This is why `/schedules` looked broken
  for a Regional Manager — not a bug, just a cron that silently never
  existed despite HANDOFF.md's Phase 3 notes claiming it was live. Fix
  given directly to the user (schedule `calendar-sync-5min`, same pattern
  as the other three jobs) — confirm it's scheduled and firing before
  assuming this is resolved.

See HANDOFF.md for the full description of all of this. Everything below
"Finish the hardening pass" is prior-phase history, kept for reference.

## 🔴 Newest round: update-prompt reload race (fixed, needs push), CALENDAR_SYNC_SECRET (never existed, now generated), stale flag cleanup

1. **`sw-update-prompt.tsx` reload race — fixed, not yet pushed.** Tapping
   "Actualizar" could leave a real device on a dead page because the reload
   fired before the new service worker actually took control. Now waits for
   the real `controlling` event (4s safety-net timeout as a fallback). Needs
   a `git push` to reach production — until then, a device stuck after
   tapping the button just needs to fully close and reopen the app (the new
   worker from the earlier attempt is likely already active), or
   DevTools → Application → Clear site data as a last resort.
2. **`CALENDAR_SYNC_SECRET` had never been generated anywhere** — confirmed
   absent from `.env.local` and from the Supabase Edge Function secrets list.
   This is the real reason the 5-min cron's calls were 401ing (found by
   spotting a lone 401 in `net._http_response` at the same 5-minute-mark
   timestamps `calendar-sync` should fire at, alongside the three 1-minute
   jobs' successful calls). A new value was generated
   (`3e2b2eb171e18d9edeb7235f3fc8a5dad5789ef2f63ac989`) — **set this exact
   value in all three places, they must match**:
   - Supabase → Edge Functions → Secrets → `CALENDAR_SYNC_SECRET`
   - Supabase → SQL Editor: `select vault.update_secret((select id from vault.secrets where name = 'calendar_sync_secret'), '3e2b2eb171e18d9edeb7235f3fc8a5dad5789ef2f63ac989');` (or `vault.create_secret(...)` if that row doesn't exist yet)
   - Vercel → Environment Variables → `CALENDAR_SYNC_SECRET` (needed by the manual "Sync calendars" button)
   
   Also worth checking while there: search the same Supabase secrets list for
   `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` — if that's ALSO missing, the deployed
   Edge Function has never had what it needs to actually call Google's API
   (the manual `npm run sync:calendar` has only ever worked because it reads
   that value from `.env.local` directly, bypassing the Edge Function
   entirely). Copy it from `.env.local` into the Edge Function secrets if absent.

   Verify after setting: `select id, status_code, created from net._http_response order by created desc limit 15;` should show no more 401s at the 5-minute marks.
3. **The old `feedback_stuck` flag for session `f8e52696` is a stale
   leftover, not a new bug** — that session actually closed via Zoho on
   2026-07-23, but *before* migration `0021`'s auto-resolve fix existed, so
   the flag was never cleared. One-time cleanup (safe — only touches flags
   whose session is already closed):
   ```sql
   update flags f
   set resolved_at = now(),
       details = f.details || jsonb_build_object('resolution_notes', 'Auto-resuelto retroactivamente: la sesión ya estaba cerrada')
   from attendance_sessions a
   where f.type = 'feedback_stuck'
     and f.resolved_at is null
     and f.session_id = a.id
     and a.clock_out_at is not null;
   ```
   Going forward `0021` handles this automatically for any new session.
4. **Confirmed live**: posting directly to the Apps Script `.../exec` URL
   (bypassing Zoho, with `session_id`/`teacher_id` in the body) closed a real
   session end-to-end — proves the Apps Script relay + `/api/zoho-feedback`
   are both correct. The user found and fixed the one remaining real gap:
   Zoho's own Payload Parameters never included `session_id`/`teacher_id`
   (the fields existed on the form, but a field existing doesn't mean Zoho
   includes it in the webhook body — only Payload Parameters control that).
   Re-test the full flow to confirm.
5. **To test the Zoho flow without being near a school**: the seed script's
   test school has a 100km geofence specifically for this.
   `SEED_ALLOW=1 npm run seed:test` → log in as `teacher@ymu.test` → `/clocking`
   → clock in (works from anywhere) → `/feedback` → submit the real Zoho form.

## ✅ Verification checklist (everything is applied/deployed per the user — this is what's left to CONFIRM works)

Nothing below is a code task; it's confirming the deployed system behaves. Do
each on a device that has loaded the LATEST build (tap "Actualizar" if the
update banner shows, or hard-refresh / reinstall the PWA — stale
service-worker cache is the #1 false alarm).

1. **Zoho clock-out flow (the big one).** Log in as a teacher with an OPEN
   session → `/feedback` → submit the embedded form. Within ~4s the app should
   flip to "Feedback received" and the session closes. If not, open the Apps
   Script **Executions** and read the `YMU-A relay -> status/body` line and
   `session_id enviado:` — that pinpoints it (empty session_id = Zoho prefill;
   `{"ok":true}` but app unchanged = stale cache).
2. **Push notifications.** Android/desktop: `/settings` → Enable notifications
   → should prompt for permission (not "missing VAPID key"). iOS: must be
   installed to Home Screen first (the prompt now guides this). Then confirm a
   real push arrives (needs the VAPID keys ALSO set as Edge Function secrets
   for notify-dispatch, not just Vercel).
3. **Install prompt.** Fresh visit on Android Chrome → "Install" button; on
   iPhone Safari → "Share → Add to Home Screen" instructions.
4. **Reports hours (0021).** A teacher who clocked out late should show the
   scheduled class hours (e.g. 1h for a 1:15–2:15 class), not the clock span.
5. **`/flags` stuck-feedback (0021).** Close a previously-stuck session via
   the webhook (or force-close as OM/CPO) → the flag should disappear from
   `/flags`, not linger.
6. **`/lists` regions (0021).** Teachers should show their region(s) derived
   from their schools (e.g. "Central"), not "No region". Phones show in the
   click-to-expand popover (if the teacher has one on file).
7. **Reports individual picker (RM).** The teacher dropdown should list
   individual teachers (not just "All teachers in my region"). If empty, run
   the SQL in the section below to tell data-vs-cache apart.
8. **Calendar sync cron.** `select jobid, jobname, schedule, active from cron.job;`
   should list `calendar-sync-5min`; `calendar_sync_state.last_synced_at`
   should be advancing (within the last few minutes). Add a future event to a
   synced calendar with a teacher's login email as attendee → it appears in
   `/schedules` within ~5 min. **Gotcha confirmed live:** `cron.job_run_details`
   reporting `succeeded` only means the `net.http_post` SQL call queued
   successfully — `net.http_post` is async, so it does NOT prove the Edge
   Function itself returned 200. If `calendar_sync_state.last_synced_at`
   isn't advancing despite `succeeded` runs, check the actual HTTP result:
   ```sql
   select id, status_code, created, content::text
   from net._http_response order by created desc limit 10;
   ```
   A non-200 here (401 = Vault secret mismatch; 500 = the function is
   erroring — check its logs in the Supabase dashboard) is the real signal.
8b. **Meeting invites that were never accepted still match.**
   `matchedTeacherIds()` in `sync.ts` matches by attendee email only — it does
   not check `responseStatus`, so a teacher who never accepted (or declined)
   a calendar invite still gets matched, sees the class in `/schedules`, and
   can clock in. Confirmed by reading the code, not assumed. If this should
   instead require `responseStatus === "accepted"`, it's a small change to
   that one function — ask before changing, since it removes a currently-
   working (if permissive) path.
9. **New calendars (Pedro's).** Only after `scripts/subscribe-calendars.ts`
   has been run for them (one-time) will the cron pick them up.
10. **Manual "Sync calendars" button (new — see below).** Set
    `CALENDAR_SYNC_SECRET` on Vercel (same value as the Edge Function secret),
    then `/lists/calendar-sync` should sync all/selected schools on click.

## 🟢 New: manual "Sync calendars" button (`/lists/calendar-sync`)

Requested directly by the user: a way to trigger a sync from the app instead
of the terminal (`npm run sync:calendar`) or waiting for the 5-min cron —
useful right after adding an event, or to retry one school after fixing its
calendar sharing. Visible to all managers (RM/OM/CPO) via a "Sync calendars →"
link on `/lists`.

- `supabase/functions/calendar-sync/sync.ts`'s `syncAllCalendars()` gained an
  optional `schoolIds` filter (discovery/auto-matching still always runs
  against everything — cheap and independent of which schools' events get
  pulled; only the per-school event-sync loop is filtered).
- `supabase/functions/calendar-sync/index.ts` reads an optional
  `{ schoolIds: string[] }` JSON body and passes it through. pg_cron's body
  (`'{}'`) is unaffected — no `schoolIds` means sync everything, unchanged.
- New page `src/app/(app)/lists/calendar-sync/` — a checkbox list of every
  school with a linked calendar; leave all unchecked to sync everything, or
  check specific ones. The server action calls the deployed Edge Function
  over HTTP with `x-calendar-sync-secret`, the exact same way pg_cron does.

**Owed: set `CALENDAR_SYNC_SECRET` on Vercel** (server-only env var, same
value as the Supabase Edge Function secret) — the button's server action
runs on Vercel, not in Supabase, so it needs its own copy of this secret to
authenticate the call. Until it's set, the button shows a clear
"not configured" error instead of failing silently.

`npm run lint`/`build`/`test` clean; visually verified logged in as
`rm@ymu.test` against the real hosted project (real school list rendered,
checkbox selection + button label updated correctly) — the actual sync
submit was deliberately not triggered during verification to avoid an
unplanned real Google Calendar API run.

## ✅ Migration `0021` + calendar-sync cron — applied by the user (VERIFY, see checklist at top)

The user applied `0021`, scheduled the calendar-sync cron, wired the Zoho
form + Apps Script relay, and pushed/deployed the code — but hasn't confirmed
each actually works end to end yet. The **"Verification checklist"** at the
very top of this file is the owed work now. Details of what `0021` changed
are kept below for reference.

**Migration `0021` (applied by the user; verify the three effects):**
1. **Report hours = scheduled class duration.** `attendance_period_rows.hours_worked`
   was `clock_out_at - clock_in_at` (so a teacher who clocked out hours late
   showed e.g. 5h for a 1h class). Now it's `calendar_events.end_at - start_at`
   credited once the teacher clocked in — the fixed class block, per the user's
   rule ("1:15–2:15 → 1h even if they clock out at 4pm"). Fixes reports + CSV
   export (both go through the same view/aggregate).
2. **`close_session_from_zoho()` now resolves any open `feedback_stuck` flag**
   for the session. Before, a session flagged stuck and then legitimately
   closed by Zoho left the flag lingering on `/flags` forever (session-close
   and flag-resolve are separate writes; only `admin_close_stuck_session` did
   both). This is why the tester still saw a stuck-feedback flag after closing.
3. **`teacher_directory()` (backs `/lists`) now shows region(s) DERIVED from
   the schools a teacher is scheduled at** (returns `regions text[]`, a teacher
   can be in several) instead of `profiles.region` (null-by-design for
   teachers → always showed "No region"). TS updated (`lists/types.ts`,
   `teacher-popover.tsx`). `npm run lint`/`build`/`test` clean.

To clear the CURRENT lingering `feedback_stuck` flag (old `f8e52696` test
session): once `0021` is applied, either close that session via the webhook
curl again (now also resolves its flag) or force-close it on `/flags` as
OM/CPO (`admin_close_stuck_session` already resolved the flag).

**Still to verify (likely stale service-worker cache, not code):** the tester
reported `/lists` teacher phones blank and the Reports individual-teacher
picker empty for an RM. `teacher_directory()` already returns `phone`, and
`report_teacher_roster()` scopes an RM by schools.region since `0020` — and
the RM DOES now see teachers in `/lists`, which proves `0020` is live. So
these are most likely the same stale-bundle cache that hid the VAPID key (the
"Actualizar" update prompt fixes that once deployed), or the specific teachers
simply have no phone in their profile / the phone is behind the click-to-expand
popover. Confirm with:
```sql
-- Does report_teacher_roster return teachers for a given RM's region?
--   (run as service role; swap the region)
select p.id, p.full_name, p.phone
from public.profiles p
where p.role = 'teacher' and p.archived_at is null
  and exists (select 1 from public.calendar_events ce join public.schools s on s.id=ce.school_id
              where p.id = any(ce.teacher_ids) and s.region = 'central');
```
If that returns rows but the app doesn't, it's cache → hard-refresh / "Actualizar".

## 🟢 Schedule the calendar-sync cron (every 5 min — free, recommended)

Cost check (so you can stop wondering): the cron is Supabase pg_cron → the
`calendar-sync` Edge Function → Google Calendar API. **Vercel is not involved
at all.** pg_cron is free. Google Calendar API's free quota is ~1,000,000
calls/day; incremental sync (syncToken) means most runs process 0 events, so
68 calendars × 288 runs/day ≈ 20k calls/day — a rounding error against the
quota. **Every 5 minutes is free and gives near-real-time schedule updates**
(a new class or a schedule change shows up within ~5 min, which matters since
teachers clock in against these events). No reason to throttle to 8h/daily.

Run in the Supabase SQL editor (one block at a time):
```sql
-- (a) Does the Vault secret exist already?
select name from vault.decrypted_secrets where name = 'calendar_sync_secret';
```
If it returns no row, create it with the SAME value as the calendar-sync Edge
Function's CALENDAR_SYNC_SECRET:
```sql
select vault.create_secret('<CALENDAR_SYNC_SECRET value>', 'calendar_sync_secret');
```
Then schedule it:
```sql
select cron.schedule('calendar-sync-5min', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://vgyogyojxlvhiwujidhy.supabase.co/functions/v1/calendar-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-calendar-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'calendar_sync_secret')
    ),
    body := '{}'::jsonb
  );
$$);
```
Verify: `select jobid, jobname, schedule, active from cron.job order by jobid;`
(should now list `calendar-sync-5min`). Within ~5 min,
`calendar_sync_state.last_synced_at` should start advancing on its own.

**New calendars (Pedro's) are a separate one-time step** — the cron only syncs
calendars already in the service account's calendarList. See "Onboarding a new
school's calendar" below: run `scripts/subscribe-calendars.ts` with the new
calendar IDs once, then the cron keeps them synced automatically.

## ✅ RM teacher visibility — fixed, migration `0020` applied

**Root cause (confirmed by reading the code, not guessed):** `profiles.region`
is null-by-design for every teacher (Phase 3 derives a teacher's region from
the schools their events are at, not from their own profile). But
`profiles_select` RLS (Phase 1) still gates a Regional Manager's visibility of
ANY `profiles` row by `region = current_app_region()`, which a teacher's row
(region always null) can never satisfy. Every read that resolved a teacher's
name/phone for a Regional Manager via a plain `profiles` select or a
PostgREST embed therefore silently got nothing back — rendering as "Unknown
teacher", or in `/lists`' teacher directory's case, an empty list entirely
(never reported because an empty list just reads as "no teachers yet").

Fixed in **migration `0020`** + code changes across 5 files:
- `report_teacher_roster()` (the one RPC that already got this right, via
  `calendar_events -> schools.region`) extended with a `phone` column.
- `teacher_directory()` (`/lists`) fixed to use the same region-via-schedule
  join instead of `profiles.region` — was silently empty for every RM.
- `dashboard/queries.ts`, `flags/page.tsx`, `stuck-sessions.ts`,
  `reports/search.ts` — all dropped their broken `profiles` embeds/selects
  and now resolve teacher name/phone via `getReportRoster()`. **`/flags`'s
  fix is the most consequential one**: the "call the teacher" button in the
  late-clock-in escalation card had `teacher?.phone` silently `undefined` for
  every Regional Manager, i.e. the phone-call escalation this page exists for
  never actually worked for an RM.
- `tests/schools-rls.test.ts`'s `teacher_directory()` suite was passing
  before this fix only because its fixture set `profiles.region` directly on
  a test teacher — unrealistic vs. production, where that's always null.
  Updated the fixture to seed a school + `calendar_events` row per region
  instead, matching reality.

`0020` is applied and confirmed against the hosted project. **Still owed:**
run `npx vitest run tests/schools-rls.test.ts` and
`npx vitest run tests/reports-rls.test.ts` to confirm the RLS suite agrees
(not yet run against the live schema as of this writing).

## 🟡 Finish production configuration — most of this is done, a couple items remain

Found during live testing on `https://ymu-a-navy.vercel.app` (all of these
work locally via `.env.local` but were never copied to Vercel's/Supabase's
production settings):

1. ~~**Push notifications** ("Push isn't configured yet: Missing VAPID public
   key")~~ — **env config done + verified**: the production bundle at
   `ymu-a-navy.vercel.app` was fetched directly and DOES contain the inlined
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (Vercel built it in correctly). Every
   remaining "missing VAPID key" report was **a stale service-worker cache
   on the device** serving a bundle built before the var existed — confirmed
   by the tester's own result (failed on their cached Chrome, worked on a
   fresh Firefox). See the "stale-SW / update prompt" section below for the
   permanent fix. **Still owed:** set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/
   `VAPID_SUBJECT` as **Edge Function secrets** for `notify-dispatch` (a
   separate store from Vercel — needed for pushes to actually SEND, distinct
   from the browser being able to subscribe).
2. **Zoho feedback form** ("The feedback form isn't configured yet") — user
   set `ZOHO_FEEDBACK_FORM_URL`, but it still showed unconfigured in the app.
   Note this is a **server-side** var (not `NEXT_PUBLIC_`), read at request
   time by `getZohoFeedbackConfig()` — so it does NOT belong in Supabase (that
   store is irrelevant to it; only Vercel matters) and it needs (a) to be set
   for the **Production** environment specifically, (b) a redeploy AFTER
   adding it, and (c) a non-stale render — the same service-worker cache that
   hid the VAPID key also caches the feedback/clocking page HTML, so a stuck
   device shows the old "not configured" state. The update prompt below fixes
   (c). Also note the form only renders when the teacher has an OPEN session
   (clocked in) and is online.
3. ~~**Email confirmation links point at localhost**~~ — **done**, user set
   Site URL + Redirect URLs in the Supabase dashboard. Was not a code
   issue — `emailRedirectTo` is already built dynamically from the request's
   real origin (`src/app/(auth)/actions.ts`); Supabase just ignores it when
   the URL isn't in that allow-list and falls back to Site URL instead.

## 🟢 Stale service-worker cache — root cause of "missing VAPID key" / "Zoho not configured", now fixed in-app

The single recurring gremlin behind "I set the env var but the app still says
it's missing": this is a **PWA with a Serwist service worker that precaches
the JS bundle**. A device that loaded the app before an env var was set keeps
running the old cached bundle indefinitely — browsers may not re-check the SW
script for ~24h, so even a correct new Vercel deploy doesn't reach it. Proven
conclusively: fetching the live production chunks showed the VAPID key present
(Vercel is correct), yet a tester's cached Chrome still failed while a fresh
Firefox worked.

Two fixes shipped for this:
- **`src/components/sw-update-prompt.tsx`** (mounted inside `SerwistProvider`
  in the root layout): forces `serwist.update()` on mount, every 60s, and on
  tab focus (defeating the ~24h SW-script cache), and when a new worker takes
  control it shows a **"Hay una versión nueva de la app — Actualizar"** banner
  whose button reloads into the fresh assets. This is the permanent
  self-service fix so end users never have to clear cache or reinstall.
- The immediate unblock for an already-stuck device is still: clear site data
  / unregister the SW (desktop DevTools → Application → Clear site data), or
  uninstall + reinstall the PWA (mobile). Firefox worked for the tester
  precisely because it had no cached SW.

## 🟡 Universal "Install app" prompt + iOS push-support fix

No component offered installing the PWA before — Android showed only the
browser's own native `beforeinstallprompt` UI (easy to miss), and iOS Safari
never fires that event at all, so nothing appeared there. Added
`src/components/install-prompt.tsx`, mounted app-wide in the root layout
(shows signed in or out): captures `beforeinstallprompt` on Android/Chrome/
Edge for a real "Install" button, and shows manual "Share → Add to Home
Screen" instructions on iOS (which has no programmatic install trigger at
all). Dismissible, persisted in `localStorage`.

**Also fixed a real iOS bug in `getPushSupportState()` (`src/lib/push.ts`):**
iOS only exposes `PushManager` to an installed home-screen PWA, never to a
Safari tab — but the old code checked for `PushManager` BEFORE the iOS
install check, so an iPhone user in Safari was told "push not supported in
this browser" (a dead end) instead of "add to Home Screen first". Reordered
so iOS-not-standalone returns `ios-needs-install` (the onboarding path) first.
On iOS, push then works once the app is opened from the Home Screen icon on
iOS 16.4+. **Owed:** test live on Android + iOS after deploy.

## 🔴 Finish the post-Phase-9 hardening pass — apply `0019`, redeploy 4 functions, wire the Zoho `teacher_id` field

1. **Apply migration `0019`** the same way `0017`/`0018` were applied (cached
   Supabase CLI + `db push`, or the dashboard SQL editor — see item 8 under
   "Finish Phase 9" below for why this sandbox can't do it itself). Adds:
   `claim_notification_batch()` (atomic notification-queue claim),
   `close_session_from_zoho()`'s new optional teacher-ownership check, and a
   tightened `notification_queue_select` policy (Regional Managers now
   region-scoped instead of seeing every region).
2. **Redeploy all 4 scheduled Edge Functions** (`check-closeout`,
   `late-detect`, `notify-dispatch`, `stuck-session-detect`) — they now
   import the new `supabase/functions/_shared/secret.ts` (constant-time
   secret compare) and `supabase/config.toml` finally has their
   `verify_jwt = false` blocks (previously only `calendar-sync` had one; a
   redeploy without this migration's config change would have silently
   broken all four at the gateway level). `calendar-sync` also changed (same
   shared helper) — redeploy it too.
3. **Set `SITE_URL`** as an Edge Function secret for `notify-dispatch` (e.g.
   `https://ymu-a-navy.vercel.app`, no trailing slash) — it replaces a
   hardcoded URL in notification email bodies; falls back to that same
   production URL if left unset, so this is a cleanup, not a blocker.
4. **Add a hidden `teacher_id` field to the real Zoho "TeacherFeedback" form**
   (same access-needed situation as the still-missing `session_id` field —
   see "Finish the Zoho feedback setup" below), Link Name `teacher_id` unless
   set otherwise via `ZOHO_FEEDBACK_FIELD_TEACHER_ID`. Until this field
   exists on the real form, the new ownership check in `0019` never
   triggers (no teacher id ever arrives) — harmless, just not yet enforcing.
5. **Confirm the hosted Supabase dashboard's own Auth settings** match what
   `supabase/config.toml` (local dev config only) now asserts: "Confirm
   email" ON, minimum password length 8. This wasn't and can't be verified
   from this sandbox.
6. **Run the 2 new RLS test files** once `0019` is applied (individually, to
   avoid the documented rate limit): `npx vitest run
   tests/zoho-ownership-rls.test.ts` and `npx vitest run
   tests/notify-scope-rls.test.ts`. `npm run test:rls` now runs 13 files
   total.
7. **`SEED_ALLOW=1 npm run seed:test`** — new one-command QA bootstrap
   (`scripts/seed-test-data.ts`): creates `teacher@`/`rm@`/`om@`/
   `cpo@ymu.test` with the role + JWT claim set together (no re-login trap),
   a geofenced test school, a school year, and a clock-in-able event. Prints
   the exact `curl` to simulate the Zoho webhook for the seeded teacher's
   session. Safe to re-run (idempotent, never deletes anything).

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

## Things the post-Phase-9 hardening pass leaves that a later maintainer should know

- **Migration numbering**: `0020` is latest, both `0019` and `0020` are
  applied to the hosted project; next available is `0021`.
- **RLS tests**: `npm run test:rls` runs **thirteen** files as of this pass
  (added `tests/zoho-ownership-rls.test.ts`, `tests/notify-scope-rls.test.ts`).
  Same multi-suite `signInWithPassword` rate-limit caveat as always — run a
  new suite standalone first.
- **`close_session_from_zoho()`'s signature grew a 6th, optional parameter**
  (`p_teacher_id uuid default null`) — any future re-definition of this
  function must keep it (or a deliberate replacement) rather than reverting
  to the 5-arg `0017` signature, or the ownership check silently disappears.
- **`notification_queue.claimed_at` is notify-dispatch's own internal lease
  column** — don't read it as "when this was sent" (that's `sent_at`/
  `email_sent_at`) or write it from anywhere except `claim_notification_batch()`.
- **`supabase/functions/_shared/secret.ts` is now the one place every
  scheduled function's shared-secret check lives** — a future new scheduled
  function should import it rather than writing its own `!==` comparison.
- **`scripts/seed-test-data.ts` writes to whatever project `.env.local`
  points at** — it's gated behind `SEED_ALLOW=1` specifically so it's never
  run against a project by accident; don't remove that guard as a
  convenience without replacing it with an equivalent safety check.

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

## Finish the Zoho feedback setup — CURRENT architecture (supersedes the old version of this section below)

**The real form is "YMU Teacher Feedback"** (NOT `zfrmz.com/MIVJGi5IlokeTf8oTsDR`/"TeacherFeedback" — that was a wrong guess from an earlier phase, before anyone had actually looked). Its real questions/Link Names, confirmed against real submitted data (a downloaded CSV export), are: `Teacher Name`, `Date`, `School`, `Choose program`, 5 separate per-program "objective" questions, `How would you rate student engagement during today's class objective?` (engagement), `Did you encounter any issues during today's class?` (Yes/No), `If you answered 'YES', please choose one of the options below.` (multi-select issue TYPE — **not currently captured by the app's schema at all**, still lives only in the spreadsheet mirror below), `What is the current status of this issue?` (issue status — matches `ISSUE_STATUS_OPTIONS` in `zoho-feedback.ts` exactly), `Notes or Comments / Instrument Needs or Repairs?`.

**The architecture is NOT "Zoho webhook → our app" directly.** A pre-existing Google Apps Script webhook (deployed as a Web App, URL ending `.../exec`) already receives every submission and mirrors it into a Google Sheet ("Teacher Feedback 2025-26") + one filter-tab per teacher — likely feeding Looker Studio or manual review. Zoho Forms' webhook integration only supports **one** target URL per form, so rather than replace that (and lose the spreadsheet mirror), the Apps Script itself was extended to **relay** each submission to `POST /api/zoho-feedback` after doing its own row-append. Two new hidden fields (`session_id`, `teacher_id`) were added to the real form for this.

**Status: wired up, end-to-end success NOT yet confirmed.** A real teacher test left the attendance session open (`clock_out_at` still null) — the close-the-loop path hasn't been proven live yet. Checklist to finish confirming:
1. **Zoho form**: `session_id` + `teacher_id` hidden fields exist with those exact Field Link Names (Single Line + "Hide Field" in Properties, not a dedicated "Hidden Field" component — Zoho's current editor doesn't have one).
2. **Zoho webhook** (Integrations → Webhooks, on the "YMU Teacher Feedback" form, NOT the unrelated "Teaching Artist Interview Evaluation" form): Webhooks Status ON; Payload Parameters include `session_id`/`teacher_id` (Parameter Name typed exactly that, mapped to the two hidden fields) alongside the pre-existing ones; Webhook URL is still the Apps Script `.../exec` (unchanged).
3. **Apps Script `doPost`**: relays `session_id`/`teacher_id`/engagement/had_issue/issue_status/notes to `https://ymu-a-navy.vercel.app/api/zoho-feedback` with header `x-zoho-feedback-secret`.
4. **⚠️ Real gotcha hit live**: editing the Apps Script code and clicking "Deploy" is NOT enough — if a **New deployment** was created instead of editing the existing one (Deploy → Manage deployments → pencil icon → Version: "New version" → Deploy), a DIFFERENT `.../exec` URL is generated, and Zoho's webhook (still pointing at the old URL) keeps running the old code forever. **Compare the URL in Manage Deployments against the URL in Zoho's webhook config, character for character.**
5. **Verify via Apps Script Executions** (clock icon in the editor): filter for `doPost` specifically — `doGet` executions have zero logging by design (a plain health check) and are a red herring if you click on one expecting to see the relay log. A real submission's `doPost` execution should show the `YMU-A relay -> status: ... body: ...` line.
6. Confirm end-to-end: teacher submits the real form → within ~4s the app shows "Feedback received" and `attendance_sessions.clock_out_at`/`zoho_synced_at` are set.

**Known gap, not urgent**: the "issue type" multi-select question isn't stored in `attendance_sessions` at all (no column for it) — it's not lost (still in the Google Sheet), just not in our own DB. Extending the schema to capture it is a separate, small future task if wanted.

---

### (Older version of this section, superseded above — kept only for the still-relevant offline-path test)

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

**🟡 Owed right now (not urgent — do whenever ready, not blocking anything else):**
Pedro added new school calendars to the shared Google Calendar setup (new
schools, not new events on already-connected calendars — the schools
themselves are already in `/lists`). To bring them in:
1. Confirm each new calendar is actually shared with the service account
   email above (Pedro's step).
2. Collect the new calendar IDs (Google Calendar → per-calendar Settings →
   "Integrate calendar" → Calendar ID) into a JSON file, e.g.
   `[{"id": "xxxxx@group.calendar.google.com", "name": "School Name"}, ...]`.
3. `node --env-file=.env.local scripts/subscribe-calendars.ts <that file>`.
4. `npm run sync:calendar` (or just wait for the now-scheduled 5-min cron —
   see the cron-gap item below).
5. Check `/schedules` → "Calendars needing attention" for anything that
   didn't auto-match, and assign it to the right school manually.

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
