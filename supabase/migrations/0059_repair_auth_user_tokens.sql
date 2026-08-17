-- Make a hand-made auth user able to log in.
--
-- GoTrue reads auth.users into a Go struct whose token fields are plain
-- `string`, not `*string`. A NULL in any of them makes the whole row unreadable
-- and every sign-in attempt fails with:
--
--   error finding user: sql: Scan error on column index 3,
--   name "confirmation_token": converting NULL to string is unsupported
--
-- supabase-js cannot parse that response, falls back to JSON.stringify, and the
-- login screen ends up showing the literal string "{}". That is exactly what
-- happened to teacher@ymu.org (2026-08-17): created by direct INSERT for the
-- demo, three token columns left NULL, and the account was unusable with no
-- readable error anywhere.
--
-- The Admin API and the dashboard write '' for these. A direct INSERT does not,
-- because the columns have no default — so any account created in SQL needs
-- this afterwards. Made a function rather than a one-off UPDATE because demo
-- and test accounts get made by hand more than once.
--
-- Deliberately NOT a trigger on auth.users: that table belongs to Supabase, and
-- a trigger of ours there would be one more thing to reason about during a
-- platform upgrade.

create or replace function public.repair_auth_user_tokens()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update auth.users set
    confirmation_token         = coalesce(confirmation_token, ''),
    recovery_token             = coalesce(recovery_token, ''),
    email_change_token_new     = coalesce(email_change_token_new, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    email_change               = coalesce(email_change, ''),
    phone_change               = coalesce(phone_change, ''),
    phone_change_token         = coalesce(phone_change_token, ''),
    reauthentication_token     = coalesce(reauthentication_token, '')
  where confirmation_token is null
     or recovery_token is null
     or email_change_token_new is null
     or email_change_token_current is null
     or email_change is null
     or phone_change is null
     or phone_change_token is null
     or reauthentication_token is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.repair_auth_user_tokens() is
  'Replaces NULLs with empty strings in auth.users token columns, which GoTrue cannot read as NULL — a row with any of them NULL makes that user unable to sign in, and the login screen shows "{}". Run after creating an account by direct SQL INSERT. Returns the number of rows fixed. Not needed for accounts made through the Admin API or dashboard.';

revoke execute on function public.repair_auth_user_tokens() from public, anon, authenticated;
grant execute on function public.repair_auth_user_tokens() to service_role;

-- Catch anything already broken, including the demo teacher.
select public.repair_auth_user_tokens();
