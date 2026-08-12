-- A job title, separate from the role.
--
-- YMU's Academic Manager is Juan Pelaez, and YMU wants the app to say
-- "Academic Manager" next to his name — while he keeps CPO permissions.
--
-- The obvious shortcut is to move him onto the `academic_manager` role and
-- widen that role until it matches `cpo`. That is the wrong lever. `role` is
-- the permission grant: it is what every RLS policy branches on, what
-- MANAGER_ROLES gates the Dashboard/Lists/Flags routes with, and — the part
-- that would actually break — what `ticket_owner_for_school()` uses as its
-- SECOND tier, handing a region with no Regional Manager to the Academic
-- Manager. East and West have no RM and hold 40 schools between them, so
-- making that role a synonym for CPO would silently re-route 40 schools' worth
-- of tickets as a side effect of relabelling one person.
--
-- So: role stays `cpo`, and the title he is shown under becomes data. This
-- also generalises, which the role enum cannot — an organisation has more job
-- titles than it has permission levels, and the next one costs an UPDATE
-- rather than a migration.

alter table public.profiles add column job_title text;

comment on column public.profiles.job_title is
  'What this person is called on screen, when that differs from their permission role. Display only — nothing branches on it. Null means "use the role label".';

-- Juan Pelaez: shown as Academic Manager, keeps CPO permissions (YMU
-- 2026-08-12). Matched on email rather than a hardcoded id so this migration
-- is readable and re-runnable.
update public.profiles p
   set job_title = 'Academic Manager',
       full_name = 'Juan Pelaez'
  from auth.users u
 where u.id = p.id
   and lower(u.email) = 'jpelaez@youngmusiciansunite.org';
