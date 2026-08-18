-- ===========================================================================
-- 0074 — handing out a manager role is the CPO's and the administrator's
-- ===========================================================================
--
-- 0072 read "the four org-wide roles are identical" as covering everything,
-- including who may hand out roles, and folded
-- current_can_assign_operations_manager() into current_sees_all_regions().
-- YMU stopped that (2026-08-18): "el unico que deberia poder nombrar a alguien
-- o cambiar un operations manager, academic manager, regional manager, etc. es
-- el CPO y el Administrator."
--
-- They are right, and the distinction is not cosmetic. Reading every region and
-- deciding who holds power are different kinds of permission. Collapsing them
-- meant an Operations Manager could mint more Operations Managers — which is
-- the one power in this schema that compounds, because each new holder can do
-- it again. 0004 had that guard from the start and it should not have moved.
--
-- Broader than 0004's, though, and deliberately: the old rule protected only
-- the Operations Manager seat, so an Academic Manager could still appoint
-- Regional Managers. Now ANY manager role — assigning one, or changing someone
-- who already holds one — needs the CPO or an administrator.
--
-- What the other two org-wide roles keep at /users: the roster, archiving,
-- clock-in exemptions, and creating teacher accounts. Everything except
-- deciding who is a manager.
-- ===========================================================================

create or replace function public.current_can_assign_manager_roles()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('cpo', 'administrator'), false);
$$;

comment on function public.current_can_assign_manager_roles() is
  'May the caller hand out or take away a manager role? CPO and administrator only (YMU 2026-08-18). Distinct from current_sees_all_regions(), which is about reading every region — deciding who holds power is not the same permission. Mirrored by canAssignManagerRoles() in lib/auth/roles.ts.';

revoke execute on function public.current_can_assign_manager_roles() from public, anon;
grant execute on function public.current_can_assign_manager_roles() to authenticated;

-- Superseded by the above: the Operations Manager seat is no longer a special
-- case, it is one manager role among several.
drop function if exists public.current_can_assign_operations_manager();

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

  -- Handing somebody a manager role.
  if new_role <> 'teacher' and not public.current_can_assign_manager_roles() then
    raise exception 'only the CPO or an administrator can assign a manager role';
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

  -- Taking one away, or moving somebody between manager roles. Same gate:
  -- demoting a Regional Manager is as consequential as appointing one.
  if target_role <> 'teacher' and not public.current_can_assign_manager_roles() then
    raise exception 'only the CPO or an administrator can change a manager''s role';
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
