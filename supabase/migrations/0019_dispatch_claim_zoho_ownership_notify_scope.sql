-- Post-Phase-9 hardening (security/reliability review):
--   M2  notify-dispatch duplicate-send hardening — atomic batch claim.
--   L3  close_session_from_zoho teacher-ownership check (IDOR defense).
--   L6  notification_queue_select — scope Regional Managers to their region.
--
-- All three are additive/backward-compatible: no column drops, existing RPC
-- callers keep working, and the policy only narrows what a regional_manager
-- can read (OM/CPO and own-row visibility are unchanged).

-- ===========================================================================
-- M2: atomic notification-queue batch claim.
--
-- notify-dispatch used to `select` all pending rows and only write their
-- outcome back at the end of the run. If a run ran longer than the 1-minute
-- cron cadence, the next run read the same still-'pending' rows and re-sent
-- every push/email. This adds a claimed_at lease + a claim RPC using
-- FOR UPDATE SKIP LOCKED, the standard job-queue pattern: a concurrent run
-- skips rows this run just claimed, and a claim older than the lease window is
-- reclaimable so a crashed run never strands its rows.
-- ===========================================================================

alter table public.notification_queue
  add column claimed_at timestamptz;

comment on column public.notification_queue.claimed_at is
  'Lease timestamp set by claim_notification_batch() when notify-dispatch takes a row. Prevents an overlapping run from re-sending it; a claim older than the lease window (default 5 min) is reclaimable so a crashed run''s rows are not stranded.';

-- Speeds the claim scan (only unfinished rows matter).
create index notification_queue_claimable_idx
  on public.notification_queue (created_at)
  where status = 'pending' or email_status = 'pending';

create or replace function public.claim_notification_batch(
  p_limit integer default 500,
  p_lease_minutes integer default 5
)
returns setof public.notification_queue
language sql
set search_path = ''
as $$
  with picked as (
    select id
    from public.notification_queue
    where send_at <= now()
      and (status = 'pending' or email_status = 'pending')
      and (claimed_at is null or claimed_at < now() - make_interval(mins => p_lease_minutes))
    order by created_at
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.notification_queue q
       set claimed_at = now()
      from picked
     where q.id = picked.id
    returning q.*
  )
  select * from claimed order by created_at;
$$;

comment on function public.claim_notification_batch(integer, integer) is
  'Atomically leases up to p_limit due, unfinished notification_queue rows (FOR UPDATE SKIP LOCKED), oldest first. Called only by the notify-dispatch Edge Function.';

revoke execute on function public.claim_notification_batch(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_batch(integer, integer) to service_role;

-- ===========================================================================
-- L3: close_session_from_zoho() teacher-ownership check.
--
-- The Zoho form's session_id is prefilled client-side into the form URL, so a
-- teacher could edit it to another teacher's open session and close it with
-- attacker-supplied feedback. Adds an optional p_teacher_id the webhook can
-- forward from a hidden teacher_id field on the form; when present it must
-- match the session's teacher. Backward-compatible: with no teacher id (the
-- current form has none yet) behavior is exactly as before. session_id is an
-- unguessable UUID that RLS hides from other teachers, so this is a second
-- lock, not the only one. Same 0011/0017 body otherwise, still stamps
-- zoho_synced_at on the real closing branch.
-- ===========================================================================

drop function if exists public.close_session_from_zoho(uuid, text, text, text, text);

create or replace function public.close_session_from_zoho(
  p_session_id uuid,
  p_engagement text,
  p_had_issue text,
  p_issue_status text default null,
  p_notes text default null,
  p_teacher_id uuid default null
)
returns public.attendance_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_row public.attendance_sessions;
begin
  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found then
    raise exception 'No attendance session found for id %.', p_session_id;
  end if;

  -- Ownership check first, before the already-closed early return, so a
  -- mismatched submission can never observe or mutate another teacher's row.
  if p_teacher_id is not null and v_row.teacher_id <> p_teacher_id then
    raise exception 'Feedback does not match the session owner.';
  end if;

  if v_row.clock_out_at is not null then
    return v_row; -- already closed; a retried webhook delivery is a no-op success.
  end if;

  if p_engagement is null or btrim(p_engagement) = '' then
    raise exception 'Engagement is required.';
  end if;
  if p_had_issue is null or p_had_issue not in ('Yes', 'No') then
    raise exception 'Had issue must be Yes or No.';
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         feedback_engagement = btrim(p_engagement),
         feedback_had_issue = p_had_issue,
         feedback_issue_status = nullif(btrim(coalesce(p_issue_status, '')), ''),
         feedback_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         feedback_submitted_at = now(),
         zoho_synced_at = now()
   where id = p_session_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_zoho(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.close_session_from_zoho(uuid, text, text, text, text, uuid) to service_role;

-- ===========================================================================
-- L6: notification_queue_select — region-scope Regional Managers.
--
-- 0018 let ANY manager (including a regional_manager) read EVERY queue row,
-- whose payloads carry teacher_id/session_id/school_id/distance_m for
-- incidents in other regions. Everywhere else RMs are region-scoped. This
-- narrows the RM branch to rows whose payload school_id resolves to a school in
-- the RM's region (mirroring flags_select / gps_checks_select), while keeping
-- own-row visibility for every user and all-row visibility for OM/CPO. Rows
-- with no resolvable school_id in the payload are visible only to OM/CPO (and
-- to their own recipient), which is the safe default.
-- ===========================================================================

drop policy notification_queue_select on public.notification_queue;

create policy notification_queue_select on public.notification_queue
  for select to authenticated
  using (
    recipient_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and exists (
        select 1 from public.schools s
        where s.id::text = (public.notification_queue.payload ->> 'school_id')
          and (s.region is null or s.region = public.current_app_region())
      )
    )
  );
