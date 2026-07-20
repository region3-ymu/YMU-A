# DECISIONS — YMU-A

Decisions made during planning and Phase 0, with rationale. Product-level decisions (Zoho, calendar auth, GPS policy, offline trust, SMS, event↔school matching) were confirmed with the user before implementation and are recorded in the approved plan (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`) — summarized at the bottom here for convenience. This file also captures **implementation-level** decisions made while actually scaffolding the repo, which weren't part of the original plan document.

## Implementation-level decisions (made during Phase 0 build)

### `@serwist/turbopack` instead of `@serwist/next`
The plan specified `serwist` generically. `create-next-app` on this Next.js version (16.2.10) produces a Turbopack-only project — there is no webpack build path to fall back to. `@serwist/next` requires webpack. Used **`@serwist/turbopack`** instead (same Serwist 9.5.11 release line, experimental Turbopack integration per Serwist's own docs). This changes the setup shape from the standard Serwist guide:
- Service worker source: `src/app/sw.ts` (imports `defaultCache` from `@serwist/turbopack/worker`, not `@serwist/next/worker`)
- Requires a dedicated route handler at `src/app/serwist/[path]/route.ts` using `createSerwistRoute` — this doesn't exist in the webpack setup
- `SerwistProvider` (from `@serwist/turbopack/react`) wraps the root layout to register the SW client-side, pointed at `/serwist/sw.js`
- Added `esbuild` as a dev dependency (required by `createSerwistRoute`'s `useNativeEsbuild: true` option)

Verified working: service worker registers and activates at root scope, manifest and offline fallback both precache correctly, confirmed via direct browser inspection (`navigator.serviceWorker.getRegistrations()`, Cache Storage contents) rather than just a successful build.

### Precache revision tied to git HEAD
`src/app/serwist/[path]/route.ts` shells out to `git rev-parse HEAD` for the offline-page precache revision, falling back to `crypto.randomUUID()` if git isn't available (e.g. a tarball deploy with no `.git`). This ties cache invalidation to actual deploys rather than a hardcoded string that could go stale.

### Placeholder icons generated with zero image dependencies
`scripts/generate-icons.mjs` hand-writes raw PNG bytes (manual IDAT/IHDR chunks + zlib deflate) rather than pulling in `sharp` or `canvas`. This was purely to avoid adding a heavy native-binary dependency for what is explicitly throwaway placeholder art (solid indigo square, white circle) — real branding will replace this before launch, at which point this script and its output should probably be deleted rather than maintained.

### Role-accent CSS variables added early, unused
`globals.css` defines `--accent` overrides keyed on `data-role="regional_manager|operations_manager|cpo"` even though nothing sets that attribute yet (no auth exists). This anticipates the plan's "different main color per role" requirement (PRD, Settings section) so Phase 1 only needs to set the attribute on `<html>`, not invent the color scheme.

### `.env.example` pre-populated with every phase's future variables
Rather than adding env var placeholders phase-by-phase, all of them (Google service account, VAPID, Resend, Zoho) were added to `.env.example` upfront with comments noting which phase introduces each, so the file only needs value backfilling later, not restructuring.

### CI builds with placeholder Supabase env vars
`.github/workflows/ci.yml` passes fake `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` values to `npm run build`. This is required because Next.js needs these to be defined at build time (they're inlined into client bundles) even though no real Supabase calls happen during a static build — without this, CI would fail on missing env vars unrelated to actual code correctness.

## Implementation-level decisions (made during Phase 1 build)

### `src/proxy.ts`, not `middleware.ts`
Next.js 16 renamed the middleware file convention to **proxy** (`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`; the old name is deprecated). The planned `middleware.ts` is therefore `src/proxy.ts` with an exported `proxy()` function — functionality identical. Per the Next auth guide, it does **optimistic checks only** (cookie/JWT, no DB queries); authoritative checks live in `src/lib/auth/dal.ts` and in RLS.

### Role rides in the JWT via `app_metadata.app_role`
The proxy needs the role without a DB round-trip on every navigation. A DB trigger stamps `app_role: 'teacher'` into `auth.users.raw_app_meta_data` at signup and `promote_user()` keeps it in sync. `app_metadata` is not client-writable. Consequence: after a promotion, the target's JWT is stale for up to one token refresh (~1 h) — acceptable because the proxy check is only optimistic; the DAL and RLS see the new role immediately.

### `data-role` on the (app) layout wrapper, not `<html>`
Phase 0 anticipated setting `data-role` on `<html>` from the root layout. That breaks in practice: the root layout does **not** re-render on soft navigations (the post-login server-action redirect is one), so the attribute would be stale until a hard reload. Instead the `(app)` route-group layout — which mounts fresh whenever navigation crosses from the (auth) group — sets `data-role` on its wrapper div, and the `globals.css` selectors were relaxed from `:root[data-role=…]` to `[data-role=…]`.

### Archived-account gate via `/auth/signout` route handler
Server components can't write cookies mid-render, so the DAL can't call `signOut()` directly when it finds `archived_at` set (the session would survive and redirect-loop). Archived users are redirected to `GET /auth/signout?error=archived`, a route handler that clears the session and lands on `/login` with the archived message. The login action additionally checks `archived_at` immediately after password verification, so an archived user can't even establish a session.

### RLS enabled but not FORCEd; column protection via trigger
`FORCE ROW LEVEL SECURITY` would make the `current_app_role()`/`current_app_region()` security-definer helpers recurse into the very policies that call them (table owner stops bypassing RLS). So: RLS is enabled, owner/service-role bypass is relied on for the helpers, table grants are cut to `select, update` for `authenticated`. Because RLS can't restrict individual columns, a `BEFORE UPDATE` trigger rejects changes to `role`/`region`/`archived_at` by non-OM/CPO callers (and deliberately lets JWT-less service-role sessions through).

### Promotion matrix enforced in the `promote_user()` RPC, mirrored in UI
OM may set teacher↔regional_manager (region required for RM, cleared otherwise); only CPO may appoint/demote operations managers; `cpo` is never assignable via RPC (manual seed only, `0003_seed_cpo.sql`); a CPO's role is immutable via RPC. The first guards shipped in `0002`, the target-role guards in `0004_promote_target_guards.sql` (gap noticed while building the UI: an OM could have demoted the CPO). The Team page mirrors these rules so the UI never offers a submit the RPC would reject.

### First OM is promoted by the CPO in-app (user-confirmed)
The Team page is available to **both** OM and CPO, so the manually-seeded CPO appoints the first Operations Manager through the UI. No OM seed migration exists.

### Built-in Supabase email sender for now (user-confirmed)
Signup verification uses Supabase's default sender — rate-limited (~2/hour) and it rejects throwaway domains like `example.com`. Fine for dev; the Resend SMTP cutover (a dashboard configuration, no code change) is documented in HANDOFF.md and must happen before onboarding real teachers.

### Never name a migration `*_init.sql`
`supabase db push` silently **skips** migration files whose name part is `init` ("replace \"init\" with a different file name to apply this migration"). Phase 0's `00000000000001_init.sql` was skipped this way; the enums turned out to already exist on the hosted project, so `0002` applied cleanly. Fixed by `supabase migration repair --status applied 00000000000001` and renaming the file to `00000000000001_base_enums.sql` (same version key, so nothing re-runs).

### RLS tests run against the hosted project, not CI
No Docker on this machine ⇒ no local Supabase. `tests/rls.test.ts` (vitest) creates disposable confirmed users on the **hosted** project via the service-role key and deletes them in `afterAll`. Kept out of CI: it needs live secrets and mutates the shared project's user list. Run manually with `npm run test:rls` after any RLS-touching migration.

## Implementation-level decisions (made during Phase 2 build)

### Region write-access is trigger-enforced, reusing the Phase 1 pattern exactly
"Region assignment OM/CPO only; immutable for RMs once set" is implemented identically to how Phase 1 locked `profiles.role`/`region`/`archived_at`: RLS lets any manager `UPDATE` a `schools` row (contact info, geofence radius, lat/lng override), and a `BEFORE UPDATE` trigger (`protect_school_region()`) specifically rejects a changed `region` column unless the caller is OM/CPO. The `INSERT` policy additionally requires `region is null` for non-OM/CPO callers, so an RM can add a school but never create one pre-assigned to a region. This means "immutable for RMs" is really "RMs can never write this column, full stop" — simpler than trying to distinguish "set" vs "changed" and matches the Phase 1 precedent closely enough that the RLS tests read almost like siblings of `tests/rls.test.ts`.

### `teacher_directory()` RPC instead of syncing email onto `profiles` (user-confirmed)
Profile popovers need a teacher's email, which lives in `auth.users`. Phase 1 punted this. Chose a `SECURITY DEFINER` SQL function over a sync trigger: no duplicated, driftable copy of auth data, and it follows the same helper pattern as `current_app_role()`/`current_app_region()`. Because `SECURITY DEFINER` bypasses RLS, the function manually re-implements the `profiles_select` region-scoping (RM: own-region teachers only; OM/CPO: everyone) rather than relying on the caller's RLS context.

### No teacher↔school assignment table in Phase 2 (user-confirmed)
The brief asked for "a teacher list per school," but no data links a teacher to a specific school yet — that's meant to come from Google Calendar event matching in Phase 3 (`calendar_events.teacher_id`/`school_id`). Rather than invent a manual assignment table that Phase 3 would then have to reconcile with calendar-derived links, Phase 2's Teachers list is grouped/filterable by region only (`profiles.region`, which already exists). See NEXT_STEPS.md for what Phase 3 should do once the real link exists.

### Leaflet marker icons served from `public/leaflet/`, not bundled via `import`
`react-leaflet`'s default marker icon references relative URLs that resolve against `leaflet`'s own package location, which 404s once bundled. The standard fix (`import markerIcon from "leaflet/dist/images/marker-icon.png"` then `L.icon({ iconUrl: markerIcon.src, ... })`) does not work on this Next.js/Turbopack version — it throws `iconUrl not set in Icon options` at runtime, discovered by actually opening `/lists` in a browser rather than trusting the build to catch it. Fixed by copying the three marker PNGs into `public/leaflet/` and referencing them as plain string paths (`/leaflet/marker-icon.png`). This also means the icons work offline once the PWA's service worker caches `public/`, which a CDN-hosted icon wouldn't.

### Migration numbered `0005`, not `0003` as the original brief said
The Phase 2 task brief (written before Phase 1 finished) said `supabase/migrations/0003_schools.sql`. By the time Phase 2 started, `0003` (CPO seed) and `0004` (promote target guards) were already taken — confirmed via `supabase migration list` and `NEXT_STEPS.md`, which was more current than the brief. Used `0005_schools.sql`.

### `school_years` created standalone, not yet wired to `schools`
The PRD schema line for `schools` mentions "school_year links," but nothing before Phase 9 (school-year lifecycle: create, link schedules/attendance, archive) actually consumes that relationship. Added `school_years` as its own table (name, start_date, end_date, archived) with RLS (OM/CPO write, all managers read) and left it unlinked rather than fabricating a foreign key nothing uses yet.

### Nominatim throttled with a module-level timestamp, not a queue
Nominatim's usage policy caps unauthenticated use at 1 req/s and requires a descriptive `User-Agent`. Since schools are added one at a time by a human (≤255 total, drip-fed per the plan's own risk register), a single `lastNominatimCallAt` timestamp with a `setTimeout` delay in `lib/geocode.ts` is sufficient — no request queue needed.

## Implementation-level decisions (made during Phase 3 build)

### Dependency-free, isomorphic Google client instead of `googleapis`
`src/lib/google/calendar.ts` signs the service-account JWT with WebCrypto (`crypto.subtle`, RS256) and calls the Calendar v3 REST API with `fetch` — no `googleapis` package. Reason: the identical code must run in Next.js (Node) **and** the Supabase Edge Function (Deno), and `googleapis` is Node-oriented and heavy. This matches the project's established dependency-minimalism (cf. the hand-written PNG encoder in Phase 0). The module is also written in **erasable-only TS syntax** (explicit class fields, not constructor parameter properties) so Node's native TS stripping executes it directly — that's what lets `scripts/sync-calendar.ts` import it with no build step. `tsconfig` gained `allowImportingTsExtensions` so the runner can import `sync.ts`/`calendar.ts` with explicit `.ts` extensions (required by Node's resolver); harmless for the app, which imports via the `@/` alias.

### Edge Function is the artifact; a Node runner shares the exact core (no Docker)
The sync logic lives in `supabase/functions/calendar-sync/sync.ts` as `syncCalendar(supabase, env)`, written isomorphic (clients passed in, not constructed). `index.ts` is the Deno `Deno.serve` wrapper for pg_cron. Because this machine has no Docker (so no `supabase functions serve`), `scripts/sync-calendar.ts` (`npm run sync:calendar`) drives the **same** `syncCalendar()` from Node against the hosted DB — that's the local verification path and the command for the end-to-end acceptance test. The Edge Function imports the shared client via a relative out-of-tree path (`../../../src/lib/google/calendar.ts`); the `supabase` CLI bundler follows it. `supabase/functions` is excluded from Next's `tsconfig`/ESLint (Deno modules, `npm:` imports), and `sync.ts`/`index.ts` carry `// @ts-nocheck`.

### syncToken handling: full → incremental, 410 → full resync, first-import notification suppression
No stored token ⇒ full sync (user chose to ingest **everything**, so no `timeMin`). A stored token ⇒ incremental. A `410 GONE` clears the token and re-runs a full sync **while preserving `full_synced_at`**. Change/removal notifications are gated on `Boolean(full_synced_at)` (`detectChanges`): the very first import establishes the baseline silently (no notifying every teacher about every existing class), but a post-410 recovery — which has a `full_synced_at` — still emits real changes. Full-sync **deletion reconciliation** finds events not re-touched this pass via `synced_at < syncStartedAt` (every seen event is stamped with the run's start time), marks them cancelled, and notifies — this is the only way a full sync learns about removals, since incremental sync gets explicit `cancelled` stubs.

### Fuzzy school match: pg_trgm, name-word-similarity ∨ address-similarity, threshold 0.5
`match_school()` normalizes both strings (lowercase, strip punctuation, collapse whitespace) and scores each school as `greatest(word_similarity(name, location), similarity(address, location))`. `word_similarity` (not plain `similarity`) on the name is deliberate: Google Location is usually `"School Name, 450 Bird Rd, City"`, i.e. the name is a substring of a longer string, which plain trigram similarity scores poorly. The 0.5 threshold lives in `sync.ts` (`SCHOOL_MATCH_THRESHOLD`), so it's tunable in one place; below it the event lands in the manager unmatched queue. A **manual** assignment (`school_match_source='manual'`) survives subsequent syncs unless the event's Location text itself changes, which re-runs the fuzzy match.

### `teacher_ids uuid[]`, region derived from the event's school (both user-confirmed)
An event's matched teachers are stored as an array of every attendee whose email matches a login email — the regular teacher and any substitute are simply two matched teachers; Google has no primary/substitute distinction to import, and a "teacher or substitute changed" notification falls out of an array set-difference. Teachers can span multiple regions, so **a teacher's region is derived from the schools their events are at**, not from `profiles.region` (left untouched). Consequently event RLS/visibility and the Schedules "by region" filter key off the event's `school.region`, and a `teacher_has_scheduled_school()` helper extends `schools_select` so a teacher can read the schools they're scheduled at (their own schedule + Phase 4 clock-in map).

### `notification_queue` generic + service-role-only; Phase 3 enqueues only
`type` + `payload` (jsonb) + `send_at` + `status`, so Phase 7's reminder types reuse the same table without a schema change. Phase 3 writes `time_changed`/`location_changed`/`teacher_changed`/`event_cancelled` rows; sending is Phase 7. The table has no authenticated grants at all (service-role writes from the sync); the RLS test asserts authenticated reads are denied.

### `assign_event_school` is `SECURITY DEFINER`; RMs confined to their region on both ends
Authenticated users have no UPDATE grant on `calendar_events`, so manual matching goes through this RPC and its role/region checks are the whole authorization story (same pattern as `promote_user`). A Regional Manager can only touch an event whose **current** school is in their region (or unassigned) and can only assign a **destination** school in their region; OM/CPO are unrestricted.

### Event detail renders the description as plain text, not Google's HTML
Google Calendar descriptions can contain HTML. The detail view renders `description` as `whitespace-pre-wrap` plain text rather than injecting HTML — no sanitizer dependency, no XSS surface. Trade-off: a description authored with rich HTML shows its tags literally; acceptable for a scheduling tool and reversible later if a vetted sanitizer is added.

### Migration numbered `0006`, not `0004` as the brief said
The Phase 3 brief (written before Phase 1 finished) said `0004_events.sql`; `0004` was taken by `promote_target_guards` and `0005` by schools. Used `0006_events.sql`, consistent with `NEXT_STEPS.md`.

## Implementation-level decisions (multi-calendar sync, built after Phase 3)

Reused what worked from a companion repo (`School-Visit-Planning-YMU`, which solved a version of this problem already) and rebuilt what didn't: its schema shape (a pinned `googleCalendarId` on the school row, an unmatched-calendar review table) and its syncToken/410-handling code were worth keeping; its matching algorithm (naive exact-string match, no admin UI actually wired up, `calendarList.list()` with no pagination loop) was not — this extends YMU-A's own pg_trgm fuzzy match and manual-override RPC/UI pattern (already proven at the event level) to the calendar level instead, one layer above the existing event↔school match, which is unchanged.

### Pin-then-skip, not periodic re-validation (user-confirmed)
Once a calendar is matched to a school (`schools.google_calendar_id` set), later syncs never re-match it — a manager must explicitly relink it via `resolve_calendar_issue()`. The alternative (re-run the fuzzy match against every already-pinned school on every tick, flagging a `match_degraded` issue on drift) was presented and explicitly declined in favor of simplicity, matching the reference repo's approach. Risk accepted: a renamed calendar or a bad manual link won't self-flag; only a fresh calendar discovery can raise a new issue.

### Calendar-match threshold is a separate, untuned constant (user-confirmed)
`CALENDAR_MATCH_THRESHOLD` (0.5) and `AMBIGUITY_MARGIN` (0.08) in `sync.ts` are distinct from `SCHOOL_MATCH_THRESHOLD` — that constant was tuned for free-text event `Location` strings, while a calendar `summary` is a short, structured name with different score characteristics. Both are placeholders and **must be validated against the real planned ~30-70 calendar-summary strings** before the sync is relied on in production (see `classifyDiscoveredCalendar` in `sync.ts`, unit-tested in `tests/calendar-sync-classify.test.ts` specifically so this validation can happen offline with synthetic data, before any calendar exists).

### Column-level `REVOKE`, not a trigger, protects the new `schools` columns
`protect_school_region()` (0005) blocks a column via a `BEFORE UPDATE` trigger checking `auth.uid() is not null and role not in (om, cpo)` — that works because region is only ever written through an ordinary RLS-gated client `UPDATE`, never through an intermediate RPC. The four new calendar-match columns are different: the only intended write path besides the service-role sync is `resolve_calendar_issue()`, a `SECURITY DEFINER` RPC called *by* an authenticated manager — inside it, `auth.uid()` is **not** null (it's the calling manager's id; `SECURITY DEFINER` changes the effective role for privilege checks, not the JWT-derived session GUCs `auth.uid()` reads from). A trigger keyed on "`auth.uid()` is not null" would therefore block the RPC's own legitimate writes, not just a raw client bypass — caught before shipping by tracing through what `auth.uid()` actually resolves to inside a `SECURITY DEFINER` call, not just by pattern-matching the existing trigger. Fixed with `REVOKE UPDATE (col, ...) / REVOKE INSERT (col, ...) ... FROM authenticated` instead: column-level privilege checks run against the *executing* role (`authenticated` for a raw client call vs. the function owner for the RPC/migrations), never against `auth.uid()`, so they block direct writes while leaving the RPC (and the service-role sync, which already has a blanket `grant all` on `schools`) unaffected.

### `calendar_sync_issues.calendar_id` is a plain unique column, not a partial "open issues only" index
The natural design — a partial unique index `on (calendar_id) where resolved_at is null`, so a resolved issue doesn't block a fresh row on rediscovery while still deduplicating *open* issues — doesn't compose with Supabase/PostgREST's upsert: `.upsert(row, { onConflict: "calendar_id" })` generates a plain `ON CONFLICT (calendar_id) DO UPDATE`, which cannot target a partial index (Postgres requires the `ON CONFLICT` clause's own predicate to match, and PostgREST's upsert helper has no way to express one). Used a plain `unique` constraint on `calendar_id` instead: one row per calendar ever, and rediscovering a previously-resolved calendar as an issue again simply reopens that same row (`resolved_at` cleared) rather than inserting a duplicate — functionally equivalent for this table's purpose, and it upserts correctly.

### Single-row lease table instead of `pg_advisory_lock` for overlap prevention
`calendar_sync_lock` is a one-row table (`id boolean primary key`, `locked_until`) acquired via an atomic `UPDATE ... WHERE locked_until IS NULL OR locked_until < now()`. Not `pg_advisory_lock`: Supabase Edge Function DB connections go through a pooler and aren't guaranteed to hold one long-lived session for the life of a request, which makes session-scoped advisory locks unreliable there. The lease row works over stateless HTTP calls and self-heals (the lease simply expires) if a run crashes without releasing it.

### `calendarList` vs ACL: sharing a calendar with the service account does not make it discoverable (found live, against the real service account and real school calendars)
Discovered during first-run validation: after bulk-sharing ~68 real school calendars with the service account (Apps Script, ACL grants confirmed working — direct `events.list` against a shared calendar succeeded), `syncAllCalendars`'s discovery still reported `discovered: 0`. Root cause: Google Calendar's ACL (who can access a calendar) and a user/service-account's **calendarList** (their own personal "list of calendars I follow") are two separate resources. Sharing a calendar with a human auto-subscribes it to their calendarList because the Calendar UI does that on accept; a service account has no UI to "accept" anything, so an ACL grant alone never populates its calendarList, and `calendarList.list()` (what `listAllCalendars()` in `calendar.ts` uses for discovery) stays empty regardless of how many calendars are actually shared.
- **Fix**: added `GoogleCalendarClient.subscribeToCalendar(calendarId)` (`POST /users/me/calendarList`, 409-tolerant/idempotent) and a reusable bootstrap script, `scripts/subscribe-calendars.ts <calendar-ids.json>`, that explicitly subscribes the service account to a known list of calendar IDs. This must be run once after any batch of new calendars is shared (documented in `NEXT_STEPS.md` as part of the onboarding-a-school runbook) — there is no Calendar API endpoint that lets a service account enumerate "every calendar I have ACL access to" independent of calendarList, so a human-provided ID list (from the Apps Script's own log output, which already prints each `name (calendarId)` pair) is the only source of truth for this bootstrap step, not just this one time.
- **A second, separate bug this first run also caught**: `subscribeToCalendar` itself initially failed for all 68 calendars with `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` even though `events.list` on the same calendars succeeded fine. `calendarList.insert` is a write against the calendarList resource, which the `calendar.readonly` scope (used everywhere else in this client) doesn't cover — confirmed via the actual Google error body (`reason: "insufficientPermissions"`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT` on `calendar.v3.CalendarList.Insert`), not guessed. Fixed by adding the narrow `https://www.googleapis.com/auth/calendar.calendarlist` scope alongside `calendar.readonly` (`CALENDAR_SCOPE` in `calendar.ts`) — deliberately not the broad read-write `https://www.googleapis.com/auth/calendar` scope, which would over-grant event/calendar-data write access this sync never needs; `calendar.calendarlist` only affects the service account's own list membership.
- Verified end-to-end with real data after both fixes: `discovered: 68` (matches the Apps Script's own count), `autoMatched: 1` (the one school that already existed in `schools` at the time — `Edison Park K-8 Center`), `issuesRaised: 67` — expected, not a matching bug: the other 67 real schools simply don't have `schools` rows yet (Phase 2's Lists tab hasn't been populated with the real ~68-school roster). Populating `schools` with the real roster is the next step before most of these auto-match; until then they sit correctly in the "Calendars needing attention" queue.

### Two more real bugs, found only after the real ~72-school roster was imported and the sync run for real

Both surfaced from an actual production run, not code review — confirmed with direct evidence (RPC calls, timestamp reconstruction) before being called bugs, not just suspected.

**1. Stale/orphaned `calendar_sync_issues` rows when a calendar later succeeds.** A calendar flagged as an issue in one run (e.g. before its matching school existed) that later auto-matches in a subsequent run never had its old issue row resolved — nothing in the auto-match branch touched `calendar_sync_issues` at all. Caught by reconciling counts: 49 pinned schools + 67 "open" issues = 116, for only 68 real calendars; the union of distinct `calendar_id`s across both sets was exactly 68, proving 48 of the 67 "open" issues were for calendars that were, in fact, already correctly pinned — just never marked resolved. Fixed in `syncAllCalendars`'s auto-match branch: after successfully pinning a school, it now also resolves any open issue row for that same `calendar_id`. The 48 pre-existing stale rows were resolved manually once as a one-time cleanup; the fix prevents recurrence.

**2. Two calendars sharing a name could silently steal each other's pin.** Google Calendar allows duplicate calendar names (confirmed real: "South Dade Senior High" and "Dr. William Chapman Elementary" each exist as two separate calendars with different ids, per the Apps Script's own share log). `classifyDiscoveredCalendar` only checked whether *this calendar* was already pinned (`pinnedCalendarIds`), never whether the *target school* was already pinned to a *different* calendar. Both same-named calendars independently score a perfect match against the one real school; whichever is processed second in a later run would silently overwrite the first's link via a plain `UPDATE`, with no error (no unique-constraint violation, since it's an update to the same row, not a duplicate insert). Confirmed live: calling `match_school_calendar("South Dade Senior High")` directly returned a perfect (1.0) match, while the second calendar's *stale* issue row (from bug #1, never refreshed) still showed a bogus near-zero score — proving the theft was imminent on the next run, not yet materialized. Fixed by adding a second guard set, `pinnedSchoolIds` (by school id, not calendar id), threaded through `classifyDiscoveredCalendar` (new optional 4th param) and updated on every auto-match within the same pass; a calendar whose best match is a school already claimed by a different calendar is now flagged `school_already_linked` instead of auto-matching. Both duplicate-named pairs, plus one near-miss ("Treasure Island Elementary" naturally fuzzy-matching best against the already-claimed "Redland Elementary"), correctly landed in the review queue after the fix, confirmed against live data.

Net result after both fixes, verified against the real roster: 49 schools correctly pinned, exactly 19 genuinely open issues (9 no match, 7 ambiguous, 3 school-already-linked) — `49 + 19 = 68`, matching the real calendar count with no double-counting.

## Product-level decisions (confirmed with user before Phase 0, full detail in the plan file)

| Area | Decision |
|---|---|
| Zoho feedback form | In-app form (works offline, gates clock-out); synced to Zoho via API after submission |
| Google Calendar auth | Service account, calendar shared to its email |
| GPS "5 checks / 5 min" | Best-effort while app is foregrounded; missed checks recorded as neutral "unverifiable", not auto-flagged |
| Offline clock-in trust | Auto-accepted, labeled "offline"; server re-validates on sync; client UUID idempotency keys |
| SMS | Dropped entirely — Web Push + Resend email backup only |
| Calendar event → school matching | Fuzzy-match on the event's Location field; unmatched events surfaced to managers |
| Scheduling/cron | Supabase pg_cron + Edge Functions, not Vercel (Hobby tier cron is too limited) |

See `/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md` for the full risk register and phase-by-phase plan these decisions feed into.
