-- Make ticket insights show the tickets the reader can actually see.
--
-- agent_ticket_metrics() and agent_workload_trend() scoped themselves with
-- `assigned_agent_id = coalesce(p_agent_id, auth.uid())`, and the page never
-- passes p_agent_id. Since routing always assigns a ticket to the school's
-- Regional Manager, that meant:
--   * CPO / Operations Manager / Academic Manager saw a page of zeros, under a
--     header that says "across every region";
--   * a Regional Manager saw only tickets assigned to them personally, not
--     their region's — the same set the /tickets list shows them, but arrived
--     at by a completely different rule.
--
-- Both functions are SECURITY INVOKER over ticket_sla, which is
-- security_invoker = true, so tickets_select RLS already scopes them exactly
-- right: own region for a Regional Manager, everything for CPO/OM/Academic
-- Manager. Dropping the filter when p_agent_id is null is the whole fix. The
-- parameter stays for a per-agent drill-down, still RLS-bounded.
--
-- Also adds total_in_scope, so the page can tell "nothing is assigned to me"
-- apart from "everything is under control" — two very different readings of
-- the same grid of zeros.

-- Dropped rather than replaced: `create or replace` cannot change a function's
-- OUT columns, and this adds total_in_scope.
drop function if exists public.agent_ticket_metrics(uuid, integer);

create function public.agent_ticket_metrics(
  p_agent_id uuid default null,
  p_days integer default 30
)
returns table (
  total_in_scope integer,
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
    select * from public.ticket_sla
    -- No p_agent_id means "everything I'm allowed to see" — RLS decides that,
    -- not this function.
    where p_agent_id is null or assigned_agent_id = p_agent_id
  ),
  still_open as (
    -- 'Resolved' was folded into 'Closed' by 0040; this is just "not closed".
    select * from scope where status <> 'Closed'
  ),
  finished as (
    select * from scope
    where resolved_at is not null
      and resolved_at >= now() - make_interval(days => p_days)
  )
  select
    (select count(*) from scope)::integer,
    (select count(*) from still_open)::integer,
    (select count(*) from still_open where priority_level = 'Urgent')::integer,
    (select count(*) from still_open where sla_state = 'warning')::integer,
    (select count(*) from still_open where sla_state = 'breached')::integer,
    (select count(*) from still_open where unanswered_overdue)::integer,
    (select count(*) from finished)::integer,
    (select avg(frt_minutes)::integer from finished where frt_minutes is not null),
    (select avg(effective_ttr_minutes)::integer from finished),
    (select case when count(*) = 0 then null
                 else round(100.0 * count(*) filter (where sla_state = 'met') / count(*), 1) end
       from finished),
    (select count(*) from finished where reopen_count > 0)::integer,
    (select case when count(*) = 0 then null
                 else round(100.0 * count(*) filter (where reopen_count > 0) / count(*), 1) end
       from finished);
$$;

comment on function public.agent_ticket_metrics(uuid, integer) is
  'Ticket queue and SLA figures. With p_agent_id null the scope is everything the caller can read under tickets_select RLS (own region for a Regional Manager, all regions for CPO/OM/Academic Manager); pass p_agent_id to drill into one agent, still RLS-bounded.';

revoke execute on function public.agent_ticket_metrics(uuid, integer) from public, anon;
grant execute on function public.agent_ticket_metrics(uuid, integer) to authenticated;

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
    where p_agent_id is null or assigned_agent_id = p_agent_id
  ),
  weeks as (
    select generate_series(
      date_trunc('week', now() - make_interval(weeks => p_weeks - 1))::date,
      date_trunc('week', now())::date,
      interval '1 week'
    )::date as week_start
  )
  select w.week_start,
    (select count(*) from scope s
      where date_trunc('week', s.created_at)::date = w.week_start)::integer,
    (select count(*) from scope s
      where s.resolved_at is not null
        and date_trunc('week', s.resolved_at)::date = w.week_start)::integer
  from weeks w
  order by w.week_start;
$$;

comment on function public.agent_workload_trend(uuid, integer) is
  'Opened/closed ticket counts per week. Same scoping rule as agent_ticket_metrics: RLS decides unless p_agent_id narrows it further.';

revoke execute on function public.agent_workload_trend(uuid, integer) from public, anon;
grant execute on function public.agent_workload_trend(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: closes that predate 0040
-- ---------------------------------------------------------------------------
-- Before 0040, closing a ticket set closed_at but not resolved_at, and did not
-- require a root cause. Every "last N days" figure and the whole root-cause
-- report key off resolved_at, so those tickets are invisible to insights even
-- though they are done. Ticket #3 (closed 2026-08-13) is the live example.
--
-- root_cause_category is deliberately NOT backfilled: there is no honest value
-- to invent, and a guess would distort the exact PD-planning aggregate this
-- report exists to feed. Those tickets simply won't appear in the root-cause
-- breakdown, which is the truthful outcome.
update public.tickets
   set resolved_at = closed_at
 where status = 'Closed'
   and closed_at is not null
   and resolved_at is null;
