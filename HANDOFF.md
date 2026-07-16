# HANDOFF — YMU-A

Snapshot of the repo at the end of **Phase 2 (schools, regions, Lists tab)**. Phase 1 notes are superseded by this file (see git history for the prior `HANDOFF.md` if you need Phase 1 detail); everything below was verified by running it — RLS test suite (32/32) + driving the real dev server in a browser as OM and RM — not from memory.

## What exists right now

Everything from Phase 1 (auth, roles, RBAC — `src/app/(auth)/*`, `src/lib/auth/*`, `src/proxy.ts`, the Team page) is unchanged and still verified working; see the "Phase 1" section of git history for that detail.

**Schools & Lists tab (new in Phase 2)** — replaces the Phase 1 stub at `src/app/(app)/lists/`:

- `page.tsx` — server component; `requireRole(...MANAGER_ROLES)`, fetches `schools` (RLS-scoped) and `teacher_directory()` (RPC) in parallel, renders `ListsExplorer`
- `lists-explorer.tsx` — client component: the search box (client-side filter over already-fetched schools/teachers — dataset is small, ≤255 schools + ~100 teachers, no server-side search needed) plus the Add-school form, Schools list, Teachers list
- `add-school-form.tsx` — name/address/contact fields → `addSchool` server action → geocode → insert
- `school-card.tsx` — one school's info: map preview, region (editable `<select>` via `RegionForm` for OM/CPO, read-only badge for everyone else), an expandable "Edit contact / pin" section with `ContactEditor` (contact name/phone/geofence radius — any manager) and `LocationEditor` (manual lat/lng override, shows a "moves the pin ~N m" hint computed client-side with `haversineMeters`)
- `teacher-popover.tsx` — click-to-expand card showing email/phone, fed by `teacher_directory()` data already loaded server-side (no extra round-trip)
- `map-preview.tsx` / `leaflet-map.tsx` — Leaflet map preview. `map-preview.tsx` is the client-only `next/dynamic(..., { ssr: false })` wrapper (required because `ssr: false` only works from a Client Component per the Next.js lazy-loading guide); `leaflet-map.tsx` has the actual `MapContainer`/`Marker`. Marker icons are served from `public/leaflet/*.png` (copied from `node_modules/leaflet/dist/images`) rather than bundled via static `import` — Turbopack's static-image-import object shape didn't give Leaflet a usable `iconUrl` string and threw `iconUrl not set in Icon options` at runtime (see DECISIONS)
- `actions.ts` — server actions: `addSchool`, `updateSchoolLocation`, `updateSchoolContact`, `assignSchoolRegion` (each independently calls `requireRole` — the UI hiding a control is not the security boundary, RLS/triggers are)
- `types.ts` — `School`/`Teacher` row shapes shared across the tab's client components

**Geocoding** — `src/lib/geocode.ts`, server-only (only ever imported from `actions.ts`): tries the US Census Bureau one-line address geocoder first, falls back to Nominatim (required `User-Agent` header, throttled to ≤1 req/s via a module-level last-call timestamp — sufficient because schools are added one at a time by a human, drip-fed). Both upstreams were exercised for real during verification.

**Haversine** — `src/lib/geo/haversine.ts` (TypeScript) and `haversine_meters()` (SQL, in the migration) are deliberately kept as two implementations, per the plan. The TS one currently powers the "moved N meters" override hint; the SQL one isn't consumed by anything yet (no geofence check exists before Phase 4/5) but exists now per the Phase 2 file list so those phases can call it for server-side re-validation.

**Database** (all migrations applied to hosted project `vgyogyojxlvhiwujidhy`; local/remote history in sync through `0005`):

- `0005_schools.sql` — `schools` (name, address, contact_name, contact_phone, lat, lng, geocode_source, geofence_radius_m default 200, region, created_by, timestamps) and `school_years` (name, start_date, end_date, archived) tables + RLS; `protect_school_region()` trigger (region writable only by OM/CPO, same pattern as Phase 1's `protect_privileged_profile_columns`); `teacher_directory()` security-definer RPC (email from `auth.users`, region-scoped the same way `profiles_select` is); `haversine_meters()` SQL function
  - Note: the original Phase 2 brief said `0003_schools.sql`, but `0003`/`0004` were already taken by the end of Phase 1 — used `0005` per `NEXT_STEPS.md`, which was more current

**Tests** — `tests/schools-rls.test.ts` (vitest, same disposable-hosted-user pattern as `tests/rls.test.ts`): 16 tests covering region-immutability (RM can insert unassigned, cannot insert/change a region even in-region, OM can set and re-set it, RM keeps write access to non-region columns), region-scoped `SELECT` visibility (RM sees own-region + unassigned, not other regions; OM/CPO see all), `teacher_directory()` scoping (teacher gets nothing back, RM gets own-region only, OM gets everyone including region-less teachers), and `school_years` write-gating (OM/CPO only; all managers can read). `npm run test:rls` now runs both files — **32/32 passing**. Still not in CI (needs live hosted credentials, mutates the shared project's user list).

**CI** — unchanged from Phase 0/1.

## Verified working (browser, dev server, hosted project)

- OM added a real school ("Coral Gables Senior High School", 450 Bird Rd, Coral Gables, FL 33146) by name+address; the pin landed exactly on the school on the map tile (visually confirmed — the OSM tile itself labels that building "Coral Gables Senior High School")
- OM assigned a region ("East") to that school through the UI; persisted and re-rendered correctly on reload
- RM (region east) saw the same school with region shown as a **read-only badge**, not an editable control — no region `<select>` is rendered for non-OM/CPO roles
- RM saw a teacher in their own region via `teacher_directory()`; clicking the teacher's row expanded a popover showing real email and phone
- Search box filtered correctly: typing "gables" kept the matching school and hid the non-matching teacher, confirming the client-side filter checks name/address/contact fields and name/email/phone fields respectively
- One real runtime bug found and fixed during verification: Leaflet's default marker icon 404s under Turbopack's static-image-import handling (`iconUrl not set in Icon options`) — fixed by serving the three marker PNGs from `public/leaflet/` instead of importing them (see DECISIONS)
- All manual test users/schools created for this verification pass were deleted afterward (the hosted project has no leftover `phase2-verify-*` accounts or test schools)

## Environment / credentials status

Unchanged from Phase 1. Nothing in Phase 2 needed new env vars — Census and Nominatim are both free and keyless.

## Manual steps still owed (Supabase dashboard)

Same three items as Phase 1 (CPO seed, Resend SMTP cutover, production Site URL/redirect allowlist) — none of them are Phase 2's concern and none were touched.

## How to verify the current state yourself

```bash
npm install
npm run test:rls        # 32 tests (16 profiles + 16 schools) against the hosted project
npm run dev              # then log in as an OM/RM/CPO and visit /lists
```
