-- ===========================================================================
-- 0089 — pin search_path on the two utility functions that were missing it
-- ===========================================================================
--
-- Supabase's linter flagged haversine_meters() and normalize_location() as
-- having a mutable search_path — every other function in this codebase sets
-- search_path = '' already. Purely cosmetic here: both are LANGUAGE sql
-- functions with zero references to any table or other function, only
-- built-ins (acos, cos, sin, radians, trim, regexp_replace, lower,
-- coalesce, least, greatest), which resolve from pg_catalog regardless of
-- search_path. Nothing for a hijacked search_path to redirect. Pinning it
-- anyway to match convention and clear the advisory.
-- ===========================================================================

alter function public.haversine_meters(double precision, double precision, double precision, double precision)
  set search_path = '';

alter function public.normalize_location(text)
  set search_path = '';
