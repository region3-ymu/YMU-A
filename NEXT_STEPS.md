# NEXT_STEPS — YMU-A

Where to pick up. Phase 1 (auth, roles, RBAC) is done and verified — see `HANDOFF.md`. Next is **Phase 2: Schools, regions, geofence data model (Lists tab)** from the approved plan (`/Users/pepskq/.claude/plans/in-the-file-directory-cozy-sparrow.md`).

## Phase 2 scope (from the plan)

**Build**:
- `schools`, `school_years` tables + RLS
- Manager "Lists" tab (replace the Phase 1 stub at `src/app/(app)/lists/`): add school by name+address → geocode via Census (Nominatim fallback) → store lat/lng with manual override
- Region assignment for schools (OM/CPO only; immutable for RMs once set — **this is the region-immutability rule from the PRD; it lives on `schools`, not `profiles`**)
- School contact fields; teacher list per school/region with profile popovers (name/email/phone); search (teachers, schools)

**Files**: `src/app/(app)/lists/*`, `lib/geocode.ts`, `lib/geo/haversine.ts` + SQL twin, `supabase/migrations/0005_schools.sql` (0004 is taken).

**Done when**: a manager adds a real Miami school by address and its pin lands correctly on a map preview; region rules enforced by RLS tests.

## Things Phase 1 left that Phase 2 should know

- **Reuse, don't rebuild**: `requireRole()`/`requireProfile()` (`src/lib/auth/dal.ts`), `MANAGER_ROLES`/`REGIONS`/labels (`src/lib/auth/roles.ts`), `current_app_role()`/`current_app_region()` SQL helpers — school RLS policies should be written in terms of these helpers, same pattern as `0002_profiles_rls.sql`.
- **RM visibility over teachers** currently keys on `profiles.region`, which only managers can set and most teachers won't have. Once teacher↔school links exist (Phase 2/3), decide whether RM→teacher visibility should derive from schools instead, and if so update the `profiles_select` policy + RLS tests.
- **Profile popovers need email**, which lives in `auth.users`, not `profiles`. The Team page punted on this. Options: a security-definer view/RPC exposing email to managers, or syncing email into `profiles` via trigger. Decide in Phase 2.
- **Migration numbering**: next is `0005_...` — and never name a migration file `*_init.sql` (the Supabase CLI silently skips those; see DECISIONS).
- **Leaflet** (`react-leaflet` v5) is installed but unused — the "pin lands on a map preview" done-criterion can use it; it must be a client-only component (`dynamic import`, no SSR).
- **RLS tests**: extend `tests/rls.test.ts` (or add `tests/schools-rls.test.ts`) with the same disposable-user pattern; `npm run test:rls` currently runs only `tests/rls.test.ts`, so widen the script glob if adding files.
- **Archiving UI** doesn't exist yet (Phase 9). `archived_at` + the gate work; only service-role/SQL can set it today.

## Standing manual steps (also in HANDOFF)

- CPO seed SQL (`0003_seed_cpo.sql`) once the real CPO signs up; CPO promotes the first OM in-app.
- Resend SMTP cutover in the Supabase dashboard before onboarding at scale (built-in sender ≈ 2 emails/hour and rejects test domains).
- On first deploy: production Site URL + `/auth/confirm` redirect in the Supabase auth allowlist.

## After Phase 2

Phase 3 (Google Calendar sync) — needs `schools` for event→school fuzzy matching and the service-account env vars.
