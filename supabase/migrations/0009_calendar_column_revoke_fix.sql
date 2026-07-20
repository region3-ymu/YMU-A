-- Fix: the column-level REVOKE in 0007_calendar_sync_issues.sql never
-- actually protected anything, on any environment. Confirmed live via
-- information_schema.column_privileges (still showed `authenticated` able to
-- UPDATE/INSERT the four calendar-match columns after 0007), then reproduced
-- the root cause: 0005_schools.sql grants a TABLE-WIDE
-- `insert, update ... to authenticated`, and Postgres's ACL model only
-- consults column-level privileges when NO table-level privilege already
-- covers the operation — a column-level REVOKE is a no-op on top of an
-- existing table-wide GRANT (see the "Privileges" chapter of the Postgres
-- docs: table and column privileges are separate ACL entries, and the more
-- permissive one wins). DECISIONS.md ("Column-level REVOKE, not a trigger")
-- reasoned correctly about *why* a trigger doesn't fit here (SECURITY
-- DEFINER's resolve_calendar_issue() needs to write these columns while
-- auth.uid() is still the calling manager) but the REVOKE-only mechanism it
-- landed on doesn't work against a pre-existing blanket grant.
--
-- Real fix: revoke the table-wide insert/update, then re-grant it back
-- explicitly for every column EXCEPT the four calendar-match ones. Same
-- effective permissions as before for every other column (including
-- `region`, which is separately protected by protect_school_region()'s
-- trigger, unaffected by this).

revoke insert, update on table public.schools from authenticated;

grant insert (
  id, name, address, contact_name, contact_phone, lat, lng, geocode_source,
  geofence_radius_m, region, created_by, created_at, updated_at
) on table public.schools to authenticated;

grant update (
  id, name, address, contact_name, contact_phone, lat, lng, geocode_source,
  geofence_radius_m, region, created_by, created_at, updated_at
) on table public.schools to authenticated;
