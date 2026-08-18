-- ===========================================================================
-- 0062 — the afterschool_manager role
-- ===========================================================================
--
-- YMU asked for a manager who owns every afterschool class in every region,
-- with those classes leaving the Regional Managers' inboxes (2026-08-18).
--
-- A new enum value rather than a regional_manager with region = null. There
-- are 48 uses of current_app_region() across the policies, and a null region
-- would force every one of them to tell "no region assigned yet" apart from
-- "no region on purpose" — profiles.region is already nullable for the first
-- reason. A role of its own makes displayRole, the nav and MANAGER_ROLES fall
-- out for free, and mirrors what academic_manager already does for a scope
-- that is not regional.
--
-- Alone in its own migration because a value added by ALTER TYPE cannot be
-- USED in the transaction that added it. 0063 onwards reference it.
-- ===========================================================================

alter type public.app_role add value if not exists 'afterschool_manager';
