-- ===========================================================================
-- 0075 — a record of who reset whose sign-in
-- ===========================================================================
--
-- Team is about to be able to reset another person's password (YMU 2026-08-18:
-- James Perez cannot sign in, and there is no way to help him from inside the
-- app). That is the most powerful thing the page can do — more than changing a
-- role, because it means signing in AS somebody — and it is the only action
-- there that leaves no trace.
--
-- Roles at least have a before and after in profiles. A credential reset has
-- nothing: the auth.users row changes, encrypted_password is not readable, and
-- nobody could later answer "who did this, and when". Four people will hold
-- this button. It needs a log.
--
-- Deliberately NOT storing anything about the credential itself — no password,
-- no link, no token. The link is a bearer credential for the target's account:
-- writing it here would turn the audit trail into a way in.
-- ===========================================================================

create table if not exists public.credential_resets (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles (id) on delete set null,
  target_id uuid not null references public.profiles (id) on delete cascade,
  -- Denormalised, like news_posts.author_role: if the actor's role changes next
  -- term, this still says what they were when they did it.
  actor_role public.app_role not null,
  method text not null check (method in ('recovery_link', 'temporary_password')),
  created_at timestamptz not null default now()
);

comment on table public.credential_resets is
  'One row per password reset performed from /users. Records who, whom, how and when - never the password or the link itself, which would make the audit trail a way in.';

create index if not exists credential_resets_target_idx
  on public.credential_resets (target_id, created_at desc);

alter table public.credential_resets enable row level security;

revoke all on table public.credential_resets from anon, authenticated;
grant select on table public.credential_resets to authenticated;
grant all on table public.credential_resets to service_role;

-- Readable by the people who can perform one, and by whoever it was done to:
-- "somebody reset my password on Tuesday" is exactly the thing a person should
-- be able to check about their own account. Writes are service-role only,
-- because the action that produces them needs the service key anyway.
create policy credential_resets_select on public.credential_resets
  for select to authenticated
  using (
    target_id = auth.uid()
    or public.current_can_manage_team()
  );
