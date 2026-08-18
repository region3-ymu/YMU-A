-- ===========================================================================
-- 0067 — who can run /users
-- ===========================================================================
--
-- Three separate guards spell out the same idea in three places
-- (operations_manager, cpo) and they have to move together, or the page half
-- works: the policy lets an UPDATE through and the trigger raises on it, or
-- promote_user() accepts a caller the policy then blocks.
--
-- YMU asked for the Academic Manager and the app admin to be able to create
-- accounts too (2026-08-18). The app admin is the reason a role list is not
-- enough on its own: region3@ymu.org is a regional_manager with
-- is_app_admin = true, so today they cannot even open the page — the one
-- person maintaining the app has to ask a CPO to add a user.
--
-- Everyone who can open Team can also edit, rather than a create-only tier.
-- A page where the row controls are visible and fail on submit is worse than
-- no page, and the tier protections that actually matter are on the TARGET and
-- unchanged: the CPO role is never assignable here, and only a CPO may touch an
-- Operations Manager.
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
         p.role in ('operations_manager', 'cpo', 'academic_manager')
         or p.is_app_admin
       )
  );
$$;

comment on function public.current_can_manage_team() is
  'May the caller administer other people''s accounts at /users? Role OR is_app_admin, because the app admin (region3@ymu.org) is a regional_manager. Mirrored by canManageTeam() in lib/auth/roles.ts.';

revoke execute on function public.current_can_manage_team() from public, anon;
grant execute on function public.current_can_manage_team() to authenticated;

-- 1. The row-level write
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.current_can_manage_team())
  with check (public.current_can_manage_team());

-- 2. The column-level backstop. profiles_update_own would otherwise let a
-- teacher hand themselves a role, so this stays as the second lock.
create or replace function public.protect_privileged_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.role is distinct from old.role
    or new.region is distinct from old.region
    or new.archived_at is distinct from old.archived_at
    or new.clock_in_exempt is distinct from old.clock_in_exempt
  )
  and auth.uid() is not null
  and coalesce(public.current_can_manage_team(), false) is false
  then
    raise exception 'changing role, region, archived status, or clock-in exemption requires a team administrator';
  end if;
  return new;
end;
$$;

-- 3. promote_user(). The caller gate widens; every check on the TARGET is
-- 0004's, untouched. Note caller_role is still read for those: an app admin who
-- is a regional_manager gets 'regional_manager' here, so they are refused an
-- Operations Manager exactly like any other non-CPO.
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
  caller_role public.app_role := public.current_app_role();
  target_role public.app_role;
begin
  if not coalesce(public.current_can_manage_team(), false) then
    raise exception 'only a team administrator can change roles';
  end if;

  if new_role = 'cpo' then
    raise exception 'the CPO role can only be assigned manually (see 0003_seed_cpo.sql)';
  end if;

  if new_role = 'operations_manager' and caller_role <> 'cpo' then
    raise exception 'only the CPO can promote to operations manager';
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

  if target_role = 'operations_manager' and caller_role <> 'cpo' then
    raise exception 'only the CPO can change an operations manager''s role';
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
