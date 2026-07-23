-- Post-launch fixes found during live testing:
--   1. Report "hours worked" must reflect the SCHEDULED class duration
--      (calendar_events.end_at - start_at), not the raw clock_in→clock_out
--      span. A teacher whose 1:15–2:15pm class ran 1h should show 1h even if
--      they forgot to clock out until 4pm.
--   2. close_session_from_zoho() now also resolves any open feedback_stuck
--      flag for the session — otherwise a session that WAS flagged stuck and
--      then legitimately closed by Zoho's webhook left the flag lingering on
--      /flags forever (closing the session and clearing its escalation are
--      two different writes; only admin_close_stuck_session did both before).
--   3. teacher_directory() now reports each teacher's region(s) DERIVED from
--      the schools they're scheduled at (a teacher can be in several), instead
--      of profiles.region — which is null-by-design for teachers, so /lists
--      always showed "No region". Same calendar_events→schools.region basis
--      the RM-visibility scoping already uses.

-- ===========================================================================
-- 1. attendance_period_rows: hours_worked = scheduled class duration.
-- Full view re-declared (only the hours_worked CASE changed vs 0016); the
-- authorization WHERE clause and every other column are byte-for-byte the same.
-- ===========================================================================

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
  -- Scheduled class length, credited once the teacher has clocked in (a
  -- session exists), regardless of when — or whether — they clocked out.
  -- The class is a fixed block; a late/missing clock-out shouldn't inflate it.
  case
    when asn.id is not null and ce.start_at is not null and ce.end_at is not null
    then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
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
  'Per (teacher, matched class) attendance status/hours, one row per pair. hours_worked is the SCHEDULED class duration (end_at - start_at) when the teacher clocked in, NOT clock_out - clock_in. Authorization hand-written in the WHERE clause (unnests teacher_ids — do not rely on table RLS alone).';

grant select on public.attendance_period_rows to authenticated;

-- ===========================================================================
-- 2. close_session_from_zoho(): same 6-arg body as 0019, now also resolves an
-- open feedback_stuck flag for the session (system auto-resolution — no admin,
-- so resolved_by stays null; the note records why).
-- ===========================================================================

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

  -- If this session had been escalated as stuck, the feedback finally arriving
  -- resolves it — otherwise the flag lingers on /flags after a legitimate close.
  update public.flags
     set resolved_at = now(),
         details = details || jsonb_build_object('resolution_notes', 'Auto-resolved: Zoho feedback received')
   where type = 'feedback_stuck' and session_id = p_session_id and resolved_at is null;

  return v_row;
end;
$$;

revoke execute on function public.close_session_from_zoho(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.close_session_from_zoho(uuid, text, text, text, text, uuid) to service_role;

-- ===========================================================================
-- 3. teacher_directory(): region(s) derived from scheduled schools.
-- Return shape changes (region public.region -> regions text[]), so drop first.
-- ===========================================================================

drop function if exists public.teacher_directory();

create or replace function public.teacher_directory()
returns table (
  id uuid,
  full_name text,
  email text,
  phone text,
  regions text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.full_name,
    u.email,
    p.phone,
    coalesce((
      select array_agg(distinct s.region::text order by s.region::text)
      from public.calendar_events ce
      join public.schools s on s.id = ce.school_id
      where p.id = any (ce.teacher_ids) and s.region is not null
    ), '{}') as regions
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
    and p.archived_at is null
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

revoke execute on function public.teacher_directory() from public, anon;
grant execute on function public.teacher_directory() to authenticated;
