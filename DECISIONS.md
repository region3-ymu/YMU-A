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
