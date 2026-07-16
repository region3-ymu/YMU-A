-- Phase 1 follow-up: promote_user() lacked guards on the *target's* current
-- role — an operations manager could demote the CPO or a fellow OM. Now:
--   * a CPO's role can never be changed here (manual SQL only, mirrors how
--     it is granted in 0003_seed_cpo.sql)
--   * an operations manager's role can only be changed by the CPO

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
  if caller_role is distinct from 'operations_manager'
     and caller_role is distinct from 'cpo' then
    raise exception 'only an operations manager or the CPO can change roles';
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
      -- Region travels with the RM role; other roles are region-less in Phase 1.
      region = case when new_role = 'regional_manager' then new_region else null end
  where id = target_id;

  update auth.users
  set raw_app_meta_data =
    coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('app_role', new_role)
  where id = target_id;
end;
$$;
