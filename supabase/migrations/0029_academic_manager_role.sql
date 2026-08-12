-- Adds the academic_manager role. ALONE IN ITS OWN MIGRATION, on purpose.
--
-- Postgres will not let a newly added enum value be *used* in the same
-- transaction that adds it. Everything that references 'academic_manager' —
-- policies, routing, the promote_user matrix — therefore lives in 0030.
--
-- Scope, per YMU on 2026-08-12, which deliberately differs from the PRD:
--
--   The PRD (Module B) routes Academic/Curriculum tickets cross-regionally,
--   straight to the Academic Manager, bypassing the region entirely. YMU does
--   not want that. EVERY ticket is assigned to the Regional Manager for the
--   school's region — "si Renzo hizo un ticket en Henry Reeves y Henry Reeves
--   está marcada como Central, ese ticket me llega a mí". The Academic
--   Manager's power is READING all of them, not owning the academic ones.
--
-- So category_type survives as a label for reporting and filtering, but it
-- never changes the assignee. One routing path, not two.

alter type public.app_role add value if not exists 'academic_manager';
