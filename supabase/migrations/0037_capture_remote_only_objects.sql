-- Back-writing five objects that only ever existed in the live database.
--
-- They were applied straight to production through the Supabase MCP and never
-- landed in a file here. The result is that **this repo's migration set does
-- not apply on its own**: 0032 selects `tk.feedback_id` and filters on
-- `f.sheet_synced_at`, and replaces `feedback_for_sheet()` — none of which any
-- file in this directory creates. A `supabase db reset` produces a database
-- that 0032 fails against, and, if you got past that, an app whose
-- /tickets/insights page throws on three missing functions.
--
-- Nothing here changes production. Every statement is written to be a no-op
-- against the live database (`if not exists`, `create or replace`) and the
-- definitions are copied from `pg_get_functiondef` on the live objects rather
-- than reconstructed from memory. This file exists so the repo and the
-- database finally say the same thing.
--
-- Numbered 0037 even though these predate 0032. Migrations are a log of what
-- was done, not a tidy retelling — renumbering to "fix" the order would break
-- the remote history that has already applied them.

-- ===========================================================================
-- 1. tickets.feedback_id   (remote: 20260812171531_tickets_feedback_link)
--
-- Links a ticket back to the feedback submission that raised it, so the sheet
-- exporter can carry both on one row. SET NULL rather than CASCADE: deleting
-- feedback must not silently delete a support ticket someone is working.
-- ===========================================================================

alter table public.tickets
  add column if not exists feedback_id uuid
  references public.feedback_submissions (id) on delete set null;

create index if not exists tickets_feedback_idx
  on public.tickets (feedback_id) where feedback_id is not null;

-- ===========================================================================
-- 2. The feedback -> Google Sheet watermark
--    (remote: 20260812184325_feedback_sheet_sync)
--
-- No queue table on purpose: the rows already exist and are already ordered,
-- so a nullable timestamp plus a partial index is the whole mechanism.
-- ===========================================================================

alter table public.feedback_submissions
  add column if not exists sheet_synced_at timestamptz;

comment on column public.feedback_submissions.sheet_synced_at is
  'When this row was mirrored into the Google Sheet. Null means pending. One-shot: an exported row is never revisited, which is why the ticket columns it carries are point-in-time (see 0038).';

create index if not exists feedback_submissions_sheet_pending_idx
  on public.feedback_submissions (submitted_at) where sheet_synced_at is null;

-- The stamp. The `and sheet_synced_at is null` re-check is what makes two
-- overlapping cron ticks idempotent — neither can count the same row twice.
create or replace function public.mark_feedback_sheet_synced(p_ids uuid[])
returns integer
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.feedback_submissions
       set sheet_synced_at = now()
     where id = any (p_ids) and sheet_synced_at is null
     returning 1
  )
  select count(*)::integer from updated;
$$;

revoke execute on function public.mark_feedback_sheet_synced(uuid[]) from public, anon, authenticated;
grant execute on function public.mark_feedback_sheet_synced(uuid[]) to service_role;

-- `feedback_for_sheet()` is deliberately NOT recreated here. 0032 already
-- holds its current definition, and duplicating it would mean two files to
-- keep in step on the next column change.

-- ===========================================================================
-- 3. Ticket insights
--    (remote: 20260812130546_agent_metrics_and_root_cause_report)
--
-- All three read public.ticket_sla, which is security_invoker — so they are
-- scoped by the caller's own ticket RLS, and a service_role call returns
-- org-wide totals. That is what makes root_cause_report() usable from the
-- sheet exporter without a SECURITY DEFINER wrapper.
-- ===========================================================================

create or replace function public.agent_ticket_metrics(
  p_agent_id uuid default null,
  p_days integer default 30
)
returns table (
  open_total integer,
  open_urgent integer,
  open_warning integer,
  open_breached integer,
  unanswered integer,
  resolved_in_period integer,
  avg_frt_minutes integer,
  avg_effective_ttr_minutes integer,
  sla_compliance_pct numeric,
  reopened_in_period integer,
  reopen_rate_pct numeric
)
language sql
stable
set search_path = ''
as $$
  with scope as (
    -- coalesce(p_agent_id, auth.uid()): auth.uid() is NULL under service_role,
    -- so a cron caller must pass p_agent_id explicitly or this scopes to
    -- nobody and returns an empty row.
    select * from public.ticket_sla
    where assigned_agent_id = coalesce(p_agent_id, auth.uid())
  ),
  still_open as (
    select * from scope where status not in ('Resolved', 'Closed')
  ),
  finished as (
    select * from scope
    where resolved_at is not null
      and resolved_at >= now() - make_interval(days => p_days)
  )
  select
    (select count(*) from still_open)::integer,
    (select count(*) from still_open where priority_level = 'Urgent')::integer,
    (select count(*) from still_open where sla_state = 'warning')::integer,
    (select count(*) from still_open where sla_state = 'breached')::integer,
    (select count(*) from still_open where unanswered_overdue)::integer,
    (select count(*) from finished)::integer,
    (select avg(frt_minutes)::integer from finished where frt_minutes is not null),
    (select avg(effective_ttr_minutes)::integer from finished),
    -- Null, not zero, when nothing was resolved: "no data" and "failed
    -- everything" must not look the same on a scorecard.
    (select case when count(*) = 0 then null
                 else round(100.0 * count(*) filter (where sla_state = 'met') / count(*), 1) end
       from finished),
    (select count(*) from finished where reopen_count > 0)::integer,
    (select case when count(*) = 0 then null
                 else round(100.0 * count(*) filter (where reopen_count > 0) / count(*), 1) end
       from finished);
$$;

create or replace function public.agent_workload_trend(
  p_agent_id uuid default null,
  p_weeks integer default 8
)
returns table (week_start date, opened integer, resolved integer)
language sql
stable
set search_path = ''
as $$
  with scope as (
    select * from public.ticket_sla
    where assigned_agent_id = coalesce(p_agent_id, auth.uid())
  ),
  weeks as (
    select generate_series(
      date_trunc('week', now() - make_interval(weeks => p_weeks - 1))::date,
      date_trunc('week', now())::date,
      interval '1 week'
    )::date as week_start
  )
  -- Zero-filled: a week with no activity still appears, so a flat stretch
  -- reads as "nothing happened" rather than as missing data.
  select w.week_start,
    (select count(*) from scope s
      where date_trunc('week', s.created_at)::date = w.week_start)::integer,
    (select count(*) from scope s
      where s.resolved_at is not null
        and date_trunc('week', s.resolved_at)::date = w.week_start)::integer
  from weeks w
  order by w.week_start;
$$;

create or replace function public.root_cause_report(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  root_cause_category text,
  category_type text,
  tickets integer,
  avg_effective_ttr_minutes integer,
  schools_affected integer,
  teachers_affected integer
)
language sql
stable
set search_path = ''
as $$
  select
    s.root_cause_category,
    s.category_type,
    count(*)::integer,
    avg(s.effective_ttr_minutes)::integer,
    count(distinct s.school_id)::integer,
    count(distinct s.teacher_id)::integer
  from public.ticket_sla s
  where s.root_cause_category is not null
    and s.resolved_at is not null
    and (p_from is null or s.resolved_at >= p_from)
    and (p_to is null or s.resolved_at < p_to)
  group by s.root_cause_category, s.category_type
  order by count(*) desc;
$$;

revoke execute on function public.agent_ticket_metrics(uuid, integer) from public, anon;
revoke execute on function public.agent_workload_trend(uuid, integer) from public, anon;
revoke execute on function public.root_cause_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.agent_ticket_metrics(uuid, integer) to authenticated, service_role;
grant execute on function public.agent_workload_trend(uuid, integer) to authenticated, service_role;
grant execute on function public.root_cause_report(timestamptz, timestamptz) to authenticated, service_role;
