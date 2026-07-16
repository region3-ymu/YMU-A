# HANDOFF — YMU-A

Snapshot of the repo at the end of **Phase 1 (auth, roles, RBAC)**. Phase 0 notes are superseded by this file; everything below was verified by running it (RLS test suite + driving the real dev server in a browser), not from memory.

## What exists right now

**App shell** — Next.js 16 (App Router, TypeScript, Turbopack-only build), Tailwind 4, PWA plumbing from Phase 0 unchanged (`@serwist/turbopack`, manifest, `/~offline`, placeholder icons).

**Auth (new in Phase 1)** — full email+password auth against the hosted Supabase project:

- `src/app/(auth)/` — login, signup (name/email/phone/password), reset-password (request), update-password (post-link), verify-email (notice + resend), all server-action forms with `useActionState`; shared card layout and form primitives (`ui.tsx`); `actions.ts` holds all auth server actions
- `src/app/(auth)/auth/confirm/route.ts` — target of Supabase auth emails; `verifyOtp(token_hash, type)` → redirect to `next` (sanitized, relative-only)
- `src/app/(auth)/auth/signout/route.ts` — GET signout route; also the archived-account bounce target (server components can't write cookies, a route handler can)
- Email verification currently uses **Supabase's built-in sender** (user-confirmed decision). It is rate-limited (~2/hour) and rejects `example.com` addresses. Resend SMTP cutover steps are below.

**RBAC**:

- `src/lib/auth/roles.ts` — `AppRole`/`Region` types mirroring the DB enums, role labels, `navForRole()` (teacher: Clocking/Schedules/Reports/Settings; managers: Lists instead of Clocking; OM/CPO also get Team), `ROUTE_ROLES` path→roles map
- `src/lib/auth/dal.ts` — authoritative checks: `getProfile()` (React-`cache`d; bounces archived accounts to `/auth/signout?error=archived`), `requireProfile()`, `requireRole()`
- `src/proxy.ts` + `src/lib/supabase/proxy.ts` — **Next 16 renamed middleware to proxy; there is no `middleware.ts`**. Optimistic checks only: session refresh via `getClaims()` (this is the session-expiry handling — failed refresh ⇒ treated as signed out ⇒ `/login`), signed-out redirect, signed-in bounce off auth pages, and role gating of `/users` + `/lists` + `/clocking` via the `app_role` JWT claim
- The `app_role` claim lives in `auth.users.raw_app_meta_data` — stamped `'teacher'` at signup by a DB trigger, updated by `promote_user()`. JWT claims lag role changes by up to one token refresh (~1 h); the DAL/RLS are authoritative immediately
- `src/app/(app)/` — signed-in shell. The group layout sets `data-role` on a wrapper div (per-role accent color via `globals.css`; see DECISIONS for why it's not on `<html>`), header with role badge + sign-out. Role-aware home tiles; stub pages for `/clocking` (teacher-only), `/lists` (managers), `/schedules`, `/reports`, `/settings`
- `src/app/(app)/users/` — **Team page** (OM/CPO only): promote teacher→RM with region; CPO can also appoint/demote OMs. Mirrors the RPC's rules client-side so the UI never offers a doomed submit

**Database** (all migrations applied to hosted project `vgyogyojxlvhiwujidhy`; local/remote history in sync):

- `00000000000001_base_enums.sql` — `app_role`, `region` enums (renamed from `_init.sql`, see DECISIONS)
- `0002_profiles_rls.sql` — `profiles` table (`full_name`, `phone`, `role` default `teacher`, `region`, `subjects[]`, `emergency_contact`, `archived_at`, timestamps); signup triggers (profile creation + `app_role` JWT stamp — role is always forced to `teacher`, so privileged roles can't be created via signup); `current_app_role()`/`current_app_region()` security-definer helpers; RLS (teacher: own row; RM: own region + own row; OM/CPO: all; update-own allowed but a trigger blocks non-managers changing `role`/`region`/`archived_at`); `promote_user()` RPC
- `0003_seed_cpo.sql` — empty by design; contains the documented manual SQL for granting the CPO role (**not yet run — no real CPO exists yet**)
- `0004_promote_target_guards.sql` — `promote_user()` hardened: CPO's role immutable via RPC, OM's role changeable only by CPO

**Tests** — `tests/rls.test.ts` (vitest): 16 integration tests against the **hosted** project (creates disposable confirmed users via service role, signs in via anon key, deletes them after). Covers teacher isolation (incl. the "teacher cannot read another teacher's row" done-criterion), self-promotion denial, RM region scoping, the full promotion matrix, archived flag. Run: `npm run test:rls` (needs `.env.local`; skips politely without it). **Not in CI** — it needs live credentials and mutates the shared project's user list.

**CI** — unchanged from Phase 0 (lint, tsc, build with placeholder env). Passing locally: `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm run test:rls` (16/16).

## Verified working (browser, dev server)

- Signed-out `/` → `/login`; signed-in users bounced off auth pages
- Login/logout for all four roles; each sees role-appropriate tiles and accent color (teacher indigo `#4f46e5`, RM teal `#0d9488`, OM amber `#b45309`, CPO rose `#be123c`)
- Teacher hitting `/users` is bounced home by the proxy (JWT claim check)
- OM promoted a teacher to RM Central through the Team UI (server action → RPC → revalidate); freshly-promoted RM logged in and saw Lists + teal
- Archived account login is refused with a clear message; no session persists
- Signup → `/verify-email`; profile row created with metadata and role `teacher`; invalid-email error surfaces inline

## Environment / credentials status

- `.env.local` (gitignored): Supabase URL, anon key, service-role key, **`SUPABASE_ACCESS_TOKEN`** (CLI auth — added during Phase 1; `npx supabase link` already done, project ref `vgyogyojxlvhiwujidhy`)
- Google/VAPID/Resend/Zoho vars still unset (later phases)
- No Docker on this machine → no local Supabase stack; everything runs against the hosted project

## Manual steps still owed (Supabase dashboard)

1. **CPO seed**: after the real CPO signs up, run the SQL in `0003_seed_cpo.sql` with their user id. The CPO then promotes the first OM in-app (user-confirmed flow).
2. **Resend SMTP cutover** (before onboarding at scale): create a Resend account, verify the sending domain, then Dashboard → Project Settings → Auth → SMTP: host `smtp.resend.com`, port 465, user `resend`, password = Resend API key; raise the email rate limit. Also add `RESEND_API_KEY` to `.env.local`/Vercel for Phase 7's direct sends.
3. **When deploying**: Dashboard → Auth → URL Configuration: set Site URL to the production domain and add `https://<domain>/auth/confirm` to the redirect allowlist (localhost works out of the box).

## How to verify the current state yourself

```bash
npm install
npm run test:rls        # 16 RLS tests against the hosted project
npm run dev             # then sign up / log in at localhost:3000
```
