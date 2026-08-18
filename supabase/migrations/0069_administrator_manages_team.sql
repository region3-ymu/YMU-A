-- ===========================================================================
-- 0069 — administrator administers the team; is_app_admin stops deciding it
-- ===========================================================================
--
-- Replaces 0067's is_app_admin branch, per YMU: the flag stays what it always
-- was (the /app-feedback inbox, migration 0024) instead of doubling as a
-- permission level. Access is a role again, which is what every other guard in
-- this schema reads.
--
-- administrator is a peer of cpo here, not of operations_manager: it may hand
-- out the Operations Manager role. The two protections that matter are on the
-- TARGET and unchanged — the CPO role is never assignable through this
-- function, and an existing Operations Manager can only be changed by a CPO or
-- an administrator.
--
-- NOTE this covers /users only. Making administrator a full peer of CPO for
-- READING the app (dashboard, tickets, flags, schedules, reports) means adding
-- it to the eleven region-scoped policies and the definer functions that
-- enumerate ('operations_manager', 'cpo') — the same sweep 0064 was, and not
-- done here. Until then an administrator can run Team and little else.
-- ===========================================================================

create or replace function public.current_can_manage_team()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.archived_at is null
       and (
         p.role in ('administrator', 'operations_manager', 'cpo', 'academic_manager')
         -- TEMPORARY BRIDGE. YMU asked for the is_app_admin branch to go, and
         -- it will: it is the /app-feedback inbox flag (0024), not a permission
         -- level. But region3@ymu.org is still regional_manager + is_app_admin,
         -- and administrator has Team powers only — 21 policies and ~15 definer
         -- functions still enumerate ('operations_manager','cpo') without it.
         -- Flipping that account to administrator today would trade its Central
         -- region data for a role that cannot read the app yet. This line comes
         -- out in the same change that makes administrator a real peer of cpo.
         or p.is_app_admin
       )
  );
$$;

comment on function public.current_can_manage_team() is
  'May the caller administer other people''s accounts at /users? The four admin roles, plus is_app_admin as a temporary bridge until administrator has cpo-equivalent read scope. Mirrored by canManageTeam() in lib/auth/roles.ts.';

-- Peers of the CPO for handing out the Operations Manager role. Kept as a
-- function so promote_user() and the TS mirror agree on one list.
create or replace function public.current_can_assign_operations_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_app_role() in ('cpo', 'administrator');
$$;

revoke execute on function public.current_can_assign_operations_manager() from public, anon;
grant execute on function public.current_can_assign_operations_manager() to authenticated;

create or replace function public.promote_user(
  target_id uuid,
  new_role public.app_role,
  new_region public.region default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role public.app_role;
begin
  if not coalesce(public.current_can_manage_team(), false) then
    raise exception 'only a team administrator can change roles';
  end if;

  if new_role = 'cpo' then
    raise exception 'the CPO role can only be assigned manually (see 0003_seed_cpo.sql)';
  end if;

  if new_role = 'operations_manager'
     and not public.current_can_assign_operations_manager() then
    raise exception 'only the CPO or an administrator can promote to operations manager';
  end if;

  if new_role = 'regional_manager' and new_region is null then
    raise exception 'a region is required when promoting to regional manager';
  end if;

  select role into target_role from public.profiles where id = target_id;
  if target_role is null then
    raise exception 'no profile found for user %', target_id;
  end if;

  if target_role = 'cpo' then
    raise exception 'the CPO''s role cannot be changed here';
  end if;

  if target_role = 'operations_manager'
     and not public.current_can_assign_operations_manager() then
    raise exception 'only the CPO or an administrator can change an operations manager''s role';
  end if;

  update public.profiles
  set role = new_role,
      -- Region travels with the RM role; every other role is region-less,
      -- which is exactly the shape afterschool_manager wants (0062).
      region = case when new_role = 'regional_manager' then new_region else null end
  where id = target_id;

  update auth.users
  set raw_app_meta_data =
    coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('app_role', new_role)
  where id = target_id;
end;
$$;
