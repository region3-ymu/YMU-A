-- In-app "report a problem" button: any signed-in user can send a message +
-- an optional screenshot describing something that's broken. Visible to
-- operations_manager/cpo by role, PLUS region3@ymu.org specifically (the
-- user's explicit ask — they're the one actually running the app day-to-day
-- right now, despite being a regional_manager by role) via the new
-- `is_app_admin` flag rather than widening MANAGER_ROLES or hardcoding an
-- email/id into RLS. Any OM/CPO can flip this flag for someone else later via
-- a direct profiles update; no UI for it yet since it's a rare, deliberate
-- elevation, not a routine admin action.

alter table public.profiles
  add column is_app_admin boolean not null default false;

comment on column public.profiles.is_app_admin is
  'Grants app_feedback visibility regardless of role — for whoever is actually operating/debugging the app day-to-day, independent of their org role. Not a route/data-access elevation anywhere else.';

update public.profiles p
set is_app_admin = true
from auth.users au
where au.id = p.id and lower(au.email) = 'region3@ymu.org';

-- ---------------------------------------------------------------------------
-- app_feedback
-- ---------------------------------------------------------------------------

create table public.app_feedback (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references public.profiles (id) on delete cascade,
  -- Denormalized at submit time (not joined live) so a later role change
  -- doesn't rewrite history of what the reporter was at the time.
  submitted_by_role public.app_role not null,
  page_path text not null,
  message text not null,
  -- Path within the 'app-feedback' storage bucket; null if no screenshot attached.
  screenshot_path text,
  -- navigator.userAgent + viewport size — enough to reproduce a device-specific bug.
  device_info jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id)
);

comment on table public.app_feedback is
  'User-submitted "something is broken" reports from the in-app feedback button — message + optional screenshot + device info.';

alter table public.app_feedback enable row level security;

create policy app_feedback_insert_own on public.app_feedback
  for insert to authenticated
  with check (submitted_by = auth.uid());

create policy app_feedback_select_admins on public.app_feedback
  for select to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin)
  );

create policy app_feedback_update_admins on public.app_feedback
  for update to authenticated
  using (
    public.current_app_role() in ('operations_manager', 'cpo')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin)
  )
  with check (
    public.current_app_role() in ('operations_manager', 'cpo')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin)
  );

grant select, insert, update on public.app_feedback to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for screenshots. Path convention enforced by
-- policy: '<auth.uid()>/<filename>' — a user can only write under their own
-- folder; only admins (same rule as the table above) can read any of it.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('app-feedback', 'app-feedback', false)
on conflict (id) do nothing;

create policy app_feedback_screenshot_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'app-feedback'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy app_feedback_screenshot_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'app-feedback'
    and (
      public.current_app_role() in ('operations_manager', 'cpo')
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_app_admin)
    )
  );
