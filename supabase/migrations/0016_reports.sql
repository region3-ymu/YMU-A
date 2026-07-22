-- Phase 8: attendance reporting.
--
-- One view + one RPC, deliberately doing as little in SQL as possible:
-- weekly/monthly/quarterly bucketing and the hours/rate math all happen in
-- TypeScript (lib/reports/aggregate.ts) over the raw rows this view returns,
-- which is the easiest thing to reconcile against a seeded test dataset and
-- keeps the SQL surface small.
--
-- attendance_period_rows: one row per (matched teacher, non-cancelled,
-- school-matched class), left-joined to that teacher's attendance_sessions
-- row for it. Its WHERE clause hand-mirrors attendance_sessions_select's
-- authorization exactly (self / RM by school region / OM+CPO all) rather
-- than relying on the underlying tables' RLS, because the view's own
-- lateral-unnest of calendar_events.teacher_ids would otherwise leak a
-- classmate's row: calendar_events RLS is row-level, not
-- array-element-level, so a teacher who shares an event with a substitute
-- would see the *whole* event row (and therefore every unnested teacher_id)
-- once the RLS check on calendar_events passes for their own membership.
-- security_invoker=true is added anyway as defence in depth (harmless
-- belt-and-suspenders on PG 17, which this project runs on).

create or replace view public.attendance_period_rows
with (security_invoker = true) as
select
  ce.id as event_id,
  t.teacher_id,
  ce.school_id,
  s.region as school_region,
  ce.summary,
  ce.start_at,
  ce.end_at,
  asn.id as session_id,
  asn.clock_in_status,
  asn.clock_in_at,
  asn.clock_out_at,
  asn.origin,
  case
    when asn.id is not null then asn.clock_in_status
    when ce.end_at is not null and ce.end_at < now() then 'missed'
    else 'upcoming'
  end as attendance_status,
  case
    when asn.clock_out_at is not null
    then round((extract(epoch from (asn.clock_out_at - asn.clock_in_at)) / 3600.0)::numeric, 4)
    else null
  end as hours_worked
from public.calendar_events ce
join lateral unnest(ce.teacher_ids) as t (teacher_id) on true
join public.schools s on s.id = ce.school_id
left join public.attendance_sessions asn
  on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
where ce.status <> 'cancelled'
  and ce.school_id is not null
  and ce.all_day = false
  and (
    t.teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and s.region = public.current_app_region()
    )
  );

comment on view public.attendance_period_rows is
  'Per (teacher, matched class) attendance status/hours, one row per pair. Feeds lib/reports/aggregate.ts weekly/monthly/quarterly bucketing. Authorization is hand-written in the WHERE clause (see header comment) — do not assume calendar_events/attendance_sessions RLS alone scopes this correctly, since it unnests an array column.';

grant select on public.attendance_period_rows to authenticated;

-- ---------------------------------------------------------------------------
-- report_teacher_roster: which teachers a report picker should offer.
--
-- NOT a reuse of teacher_directory() (0005_schools.sql) on purpose:
-- teacher_directory() scopes a Regional Manager by profiles.region, which
-- Phase 3's DECISIONS.md documents as stale — a teacher's region is derived
-- from the schools their events are at, not profiles.region, and most
-- teachers now have profiles.region = null. Reusing it here would silently
-- return an empty roster for every RM. This scopes RMs the same way
-- attendance_period_rows above does: via calendar_events -> schools.region.
-- ---------------------------------------------------------------------------

create or replace function public.report_teacher_roster(p_include_archived boolean default false)
returns table (
  id uuid,
  full_name text,
  email text,
  archived_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.id, p.full_name, u.email, p.archived_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
    and (p_include_archived or p.archived_at is null)
    and (
      public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and exists (
          select 1
          from public.calendar_events ce
          join public.schools s on s.id = ce.school_id
          where p.id = any (ce.teacher_ids)
            and s.region = public.current_app_region()
        )
      )
    );
$$;

revoke execute on function public.report_teacher_roster(boolean) from public, anon;
grant execute on function public.report_teacher_roster(boolean) to authenticated;
