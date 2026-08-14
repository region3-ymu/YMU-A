-- The app's data starts on 13 August 2026. Nothing before it is real.
--
-- The initial Google Calendar sync swept in the whole of the previous school
-- year and the summer: 8,496 calendar_events start before that date. No
-- teacher ever clocked into any of them, so attendance_period_rows classifies
-- every single one as 'missed' — and a Regional Manager's "last 30 days" in
-- August was mostly July, drowning the fortnight of real data in thousands of
-- phantom absences.
--
-- Only calendar_events reaches back. attendance_sessions, feedback_submissions,
-- flags and tickets all begin on or after 13 August 2026, so the floor belongs
-- on the one view that reads calendar_events for history.
--
-- The events themselves are deliberately NOT deleted. They are Google's record
-- of what the calendars actually held, calendar-sync's sync tokens are keyed
-- against them, and deleting 8,496 rows to hide them from one view would be a
-- destructive answer to a filtering question. Bounding the view is reversible;
-- a delete is not.
--
-- Held in a function rather than inlined so the date is named once and can be
-- moved in one place — the same shape as ticket_frt_target_hours().

create or replace function public.app_data_start()
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select '2026-08-13T00:00:00Z'::timestamptz;
$$;

comment on function public.app_data_start() is
  'The instant this app''s data begins (pilot go-live). Everything earlier in calendar_events is history swept in by the initial Google sync and is excluded from attendance reporting. Mirrored in TypeScript as DATA_START_DATE in src/lib/app-data-window.ts.';

grant execute on function public.app_data_start() to authenticated, service_role;

-- Recreated with the floor added. Everything else is byte-for-byte the 0021
-- definition, including the authorization clause in the WHERE — this view is
-- security_invoker and that clause is the only thing scoping it.
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
      when asn.id is not null and ce.start_at is not null and ce.end_at is not null
      then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
      else null::numeric
    end as hours_worked
  from public.calendar_events ce
  join lateral unnest(ce.teacher_ids) as t(teacher_id) on true
  join public.schools s on s.id = ce.school_id
  left join public.attendance_sessions asn
    on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
  where ce.status <> 'cancelled'
    and ce.school_id is not null
    and ce.all_day = false
    -- The floor. Nothing this app did not witness.
    and ce.start_at >= public.app_data_start()
    and (
      t.teacher_id = auth.uid()
      or public.current_app_role() in ('operations_manager', 'cpo')
      or (
        public.current_app_role() = 'regional_manager'
        and s.region = public.current_app_region()
      )
    );

comment on view public.attendance_period_rows is
  'One row per (class, teacher) with its attendance status and scheduled hours, bounded below by app_data_start() so pre-pilot calendar history cannot show up as thousands of missed classes. security_invoker — the WHERE clause is the authorization.';

grant select on public.attendance_period_rows to authenticated;
