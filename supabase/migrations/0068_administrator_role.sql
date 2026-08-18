-- ===========================================================================
-- 0068 — the administrator role
-- ===========================================================================
--
-- 0067 reached the app admin through profiles.is_app_admin, because
-- region3@ymu.org is a regional_manager carrying that flag. YMU asked for a
-- real role instead (2026-08-18) — a peer of CPO / Academic Manager /
-- Operations Manager rather than a boolean bolted onto a regional manager.
--
-- Alone, because a value added by ALTER TYPE cannot be used in the transaction
-- that added it.
-- ===========================================================================

alter type public.app_role add value if not exists 'administrator';
