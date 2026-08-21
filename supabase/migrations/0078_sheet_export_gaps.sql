-- ===========================================================================
-- 0078 — what the spreadsheet was not saying
-- ===========================================================================
--
-- An audit of all 11 tabs of "YMU — Feedback Results 2026-27" against the app.
-- The plumbing is sound: no duplicate rows on Feedback (238 real rows against
-- 236 in the table), none on Attendance (7807 rows, every event_id+teacher
-- pair distinct), and sheet-tabs.ts's import-time column/header length guards
-- are doing their job. What is wrong is coverage.
--
--   1. Flags → "Metres from school" is EMPTY for all 120 rows. flags_for_sheet
--      reads details->>'distance_m', which only gps_out_of_fence flags carry
--      and of which there are none. detect_late_clockins never writes that
--      key. A column that has never held a value reads as "the teacher was at
--      the school" rather than "we did not answer this".
--
--   2. Flags does not export minutes_late or auto_resolved_by, both of which
--      are already sitting in details. 25 flags were auto-resolved — by
--      clock_in() when the teacher turned up inside 15 minutes, or by
--      clock_in_exempt — and they appear as "Resolved" with a blank "Resolved
--      by", which reads as a manager who could not be bothered.
--
--   3. Attendance does not export admin_edited_by/at/reason. 50 of 258
--      sessions have been rewritten by a manager and the sheet gives no sign
--      of it: a corrected row is indistinguishable from an organic one. This
--      is the tab payroll is read from.
--
--   4. Attendance has no afterschool dimension, though is_afterschool drives a
--      whole module and a dedicated manager role.
--
--   5. clock_in_attempts (224 rows) and ticket_messages (37) have no
--      representation anywhere. The first is the only record of the app ever
--      refusing a teacher; the second is the entire teacher-to-manager
--      conversation, of which the Tickets tab keeps only the SLA arithmetic.
--
--      gps_checks was going to get a tab too. It does not, because 0082
--      removes the feature: 649 of its 654 rows say 'unverifiable' with no
--      position recorded, and a tab full of that reads as evidence of absence
--      rather than absence of evidence.
--
-- Not touched here, at YMU's request: Attendance."Hours" is still the
-- SCHEDULED class length, not clock-out minus clock-in, so a teacher who
-- clocks in forty minutes late still shows full hours. Recorded so it is not
-- rediscovered as a surprise.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Flags — the reason, the lateness, and who actually closed it
-- ---------------------------------------------------------------------------
-- distance_m now falls back to the attendance session for the same
-- (event, teacher). For a late clock-in that is the distance the teacher
-- eventually clocked in from, which is the useful number and the one the
-- column has always claimed to hold. details->>'distance_m' stays first so a
-- gps_out_of_fence flag still reports the sample that raised it.
--
-- resolved_by gets a fallback too: an auto-resolved flag names the mechanism
-- rather than leaving the cell blank. 0077's 'back_to_back' joins 'clock_in'
-- and 'clock_in_exempt' there.

-- DROP first. `create or replace` cannot change a function's return type, and
-- this adds four columns to the existing 13 — Postgres refuses with
-- "cannot change return type of existing function". Same for
-- attendance_for_sheet below, and for flags_for_sheet again in 0080.
-- The grants are reissued at the foot of each block, since dropping takes them.
drop function if exists public.flags_for_sheet();

create or replace function public.flags_for_sheet()
returns table (
  flag_id uuid,
  raised_date date,
  raised_time text,
  flag_type text,
  teacher_name text,
  school_name text,
  region text,
  class_title text,
  class_date date,
  class_time text,
  status text,
  minutes_late integer,
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text,
  resolution_notes text,
  distance_m integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.id,
    (f.created_at at time zone 'America/New_York')::date,
    to_char(f.created_at at time zone 'America/New_York', 'HH12:MI AM'),
    case f.type
      when 'gps_out_of_fence'  then 'Left the school geofence'
      when 'late_clock_in'     then 'Late clock-in'
      when 'feedback_stuck'    then 'Feedback overdue'
      when 'ticket_unassigned' then 'Ticket with no owner'
      else f.type
    end,
    p.full_name,
    s.name,
    s.region::text,
    ce.summary,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    case when f.resolved_at is null then 'Open' else 'Resolved' end,
    -- Already in details since 0044; never exported. This is the difference
    -- between "two minutes behind" and "never showed up", which is the whole
    -- reason a manager opens the tab.
    coalesce(
      (f.details->>'minutes_late')::integer,
      case
        when asn.clock_in_at is not null and ce.start_at is not null
         and asn.clock_in_at > ce.start_at
        then (extract(epoch from (asn.clock_in_at - ce.start_at)) / 60)::integer
      end
    ),
    f.resolved_at,
    coalesce(
      resolver.full_name,
      case f.details->>'auto_resolved_by'
        when 'clock_in'         then 'Automatic — teacher clocked in within 15 min'
        when 'clock_in_exempt'  then 'Automatic — teacher is clock-in exempt'
        when 'back_to_back'     then 'Automatic — back-to-back class carried over'
        -- No `when null` branch: NULL = NULL is unknown, so it would never
        -- match. A flag closed by a person falls out of the concatenation
        -- below as null, which is what coalesce already handled above.
        else 'Automatic — ' || (f.details->>'auto_resolved_by')
      end
    ),
    -- The code, next to the prose it was rendered into. Pivot on this one.
    public.flag_reason_label(f.details->>'resolution_reason'),
    f.details->>'resolution_notes',
    coalesce(
      (f.details->>'distance_m')::integer,
      asn.clock_in_distance_m::integer
    )
  from public.flags f
  left join public.profiles p on p.id = f.teacher_id
  left join public.schools s on s.id = f.school_id
  left join public.calendar_events ce on ce.id = f.event_id
  left join public.profiles resolver on resolver.id = f.resolved_by
  -- flags.session_id is always null for late_clock_in (the flag is raised
  -- precisely because no session existed), so the join has to go through
  -- (event, teacher) — the same lookup the /flags page does with sessionByKey.
  left join public.attendance_sessions asn
    on asn.event_id = f.event_id and asn.teacher_id = f.teacher_id
  order by f.created_at desc;
$$;

comment on function public.flags_for_sheet() is
  'Every flag, open and resolved, with its reason code, how late the teacher was, and who or what closed it. distance_m falls back to the session the teacher eventually opened.';

revoke execute on function public.flags_for_sheet() from public, anon, authenticated;
grant execute on function public.flags_for_sheet() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Attendance — the manager's fingerprints, and afterschool
-- ---------------------------------------------------------------------------
-- The bounds now default from school_years instead of being hardcoded in
-- sheet-tabs.ts, where they were '2026-08-01' → '2027-07-01'. On 2027-07-01
-- that tab would have rewritten itself to zero rows with no error anywhere.
--
-- A month of slack below the school year start, deliberately. The year begins
-- 2026-08-13 but there is a walkthrough on 2026-08-12 sitting in the tab
-- today, and pre-term setup days are real work; tightening the floor to the
-- official start date would silently drop a row YMU can currently see. The
-- point of this change is the tab not emptying, not a narrower window.

drop function if exists public.attendance_for_sheet(timestamptz, timestamptz);

create or replace function public.attendance_for_sheet(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  event_id uuid,
  session_id uuid,
  class_date date,
  class_time text,
  class_title text,
  program text,
  is_afterschool text,
  teacher_name text,
  teacher_email text,
  school_name text,
  region text,
  regional_manager text,
  attendance_status text,
  clock_in_at timestamptz,
  clock_in_minutes_late integer,
  clock_out_at timestamptz,
  clock_out_source text,
  hours_worked numeric,
  clock_in_origin text,
  distance_m integer,
  feedback_submitted text,
  edited_by text,
  edited_at timestamptz,
  edit_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      coalesce(
        p_from,
        (select (y.start_date - interval '1 month')::timestamptz
           from public.school_years y
          where not y.archived
          order by y.start_date desc
          limit 1)
      ) as lo,
      coalesce(
        p_to,
        (select (y.end_date + interval '1 day')::timestamptz
           from public.school_years y
          where not y.archived
          order by y.start_date desc
          limit 1)
      ) as hi
  )
  select
    ce.id,
    asn.id,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    ce.summary,
    (select pr.name from public.programs pr
      where pr.active
        and exists (
          select 1 from unnest(pr.match_patterns) mp
           where position(mp in lower(coalesce(ce.summary, ''))) > 0
        )
      order by pr.sort_order
      limit 1),
    case when ce.is_afterschool then 'Yes' else 'No' end,
    p.full_name,
    u.email::text,
    s.name,
    s.region::text,
    (select rm.full_name from public.profiles rm
      where rm.role = 'regional_manager' and rm.region = s.region and rm.archived_at is null
      order by rm.created_at limit 1),
    case
      when asn.id is not null then asn.clock_in_status
      when ce.end_at is not null and ce.end_at < now() then 'missed'
      else 'upcoming'
    end,
    asn.clock_in_at,
    case
      when asn.clock_in_at is not null and ce.start_at is not null and asn.clock_in_at > ce.start_at
      then (extract(epoch from (asn.clock_in_at - ce.start_at)) / 60)::integer
    end,
    asn.clock_out_at,
    asn.clock_out_source,
    -- Unchanged, and still the SCHEDULED length rather than clock-out minus
    -- clock-in. YMU asked for it left alone (2026-08-21). It means a teacher
    -- who clocked in forty minutes late shows full hours.
    case
      when asn.id is not null and ce.start_at is not null and ce.end_at is not null
      then round((extract(epoch from (ce.end_at - ce.start_at)) / 3600.0)::numeric, 4)
    end,
    asn.origin,
    asn.clock_in_distance_m::integer,
    case when asn.feedback_settled_at is not null then 'Yes'
         when asn.id is not null then 'No'
    end,
    editor.full_name,
    asn.admin_edited_at,
    asn.admin_edit_reason
  from public.calendar_events ce
  cross join bounds b
  join lateral unnest(ce.teacher_ids) as t (teacher_id) on true
  join public.schools s on s.id = ce.school_id
  join public.profiles p on p.id = t.teacher_id
  left join auth.users u on u.id = t.teacher_id
  left join public.attendance_sessions asn
    on asn.event_id = ce.id and asn.teacher_id = t.teacher_id
  left join public.profiles editor on editor.id = asn.admin_edited_by
  where ce.status <> 'cancelled'
    and ce.school_id is not null
    and ce.all_day = false
    and (b.lo is null or ce.start_at >= b.lo)
    and (b.hi is null or ce.start_at <  b.hi)
  order by ce.start_at, s.name, p.full_name;
$$;

comment on function public.attendance_for_sheet(timestamptz, timestamptz) is
  'One row per teacher per scheduled class, bounded by the current school_years row unless told otherwise. Carries the manager edit trail and the afterschool flag. NOTE: hours_worked is the scheduled class length, not time actually clocked.';

revoke execute on function public.attendance_for_sheet(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.attendance_for_sheet(timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Clock-in attempts — every press of the button, allowed or refused
-- ---------------------------------------------------------------------------
-- Worth being straight about the size of this: of 224 attempts, 220 were
-- allowed, 7 were refused for the wrong day and 4 for an already-clocked-in
-- class. NOT ONE was refused by the geofence or for overdue feedback. So this
-- tab is not the pile of "the app wouldn't let me" evidence it might sound
-- like — it is thin, and that thinness is itself the finding: when a teacher
-- says "tech problem", there is usually no record of them trying, which points
-- at the app never loading rather than the app refusing.
--
-- Exports allowed attempts too, on purpose. attempted_at against the class
-- start is the only place the app records a teacher opening the screen on
-- time, and accuracy_m is the only signal for "GPS was hopeless indoors".

create or replace function public.clock_in_attempts_for_sheet(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  attempt_date date,
  attempt_time text,
  outcome text,
  refused text,
  denial_message text,
  teacher_name text,
  school_name text,
  region text,
  class_title text,
  class_date date,
  class_time text,
  minutes_after_start integer,
  origin text,
  accuracy_m integer,
  overdue_feedback_count integer,
  event_id uuid,
  session_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (a.attempted_at at time zone 'America/New_York')::date,
    to_char(a.attempted_at at time zone 'America/New_York', 'HH12:MI AM'),
    a.outcome,
    case when a.outcome like 'allowed%' then 'No' else 'Yes' end,
    a.denial_message,
    p.full_name,
    s.name,
    s.region::text,
    ce.summary,
    (ce.start_at at time zone 'America/New_York')::date,
    to_char(ce.start_at at time zone 'America/New_York', 'HH12:MI AM'),
    case
      when ce.start_at is not null
      then (extract(epoch from (a.attempted_at - ce.start_at)) / 60)::integer
    end,
    a.origin,
    a.accuracy_m::integer,
    a.overdue_feedback_count,
    a.event_id,
    a.session_id
  from public.clock_in_attempts a
  left join public.profiles p on p.id = a.teacher_id
  left join public.schools s on s.id = a.school_id
  left join public.calendar_events ce on ce.id = a.event_id
  where (p_from is null or a.attempted_at >= p_from)
    and (p_to   is null or a.attempted_at <  p_to)
  order by a.attempted_at desc;
$$;

comment on function public.clock_in_attempts_for_sheet(timestamptz, timestamptz) is
  'Every clock-in attempt including the allowed ones. minutes_after_start is negative when the teacher pressed the button before the class began. Deliberately does not export lat/lng — the distance the attempt resolved to is on the session.';

revoke execute on function public.clock_in_attempts_for_sheet(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.clock_in_attempts_for_sheet(timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Ticket messages — what was actually said
-- ---------------------------------------------------------------------------
-- The Tickets tab has first-response minutes, resolution minutes and paused
-- minutes, and not one word of the conversation those minutes measure.
--
-- is_internal_note is exported rather than filtered out. These are manager
-- notes about YMU's own operations, the audience for this spreadsheet is the
-- managers, and a thread with the internal notes removed reads as though the
-- agent solved things by silence.

create or replace function public.ticket_messages_for_sheet()
returns table (
  ticket_number integer,
  sent_date date,
  sent_time text,
  sender text,
  sender_role text,
  channel text,
  internal_note text,
  message_body text,
  resulting_status text,
  ticket_status text,
  teacher_name text,
  school_name text,
  region text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    tk.ticket_number,
    (m.created_at at time zone 'America/New_York')::date,
    to_char(m.created_at at time zone 'America/New_York', 'HH12:MI AM'),
    sender.full_name,
    sender.role::text,
    m.channel,
    case when m.is_internal_note then 'Yes' else 'No' end,
    m.message_body,
    m.resulting_status,
    tk.status,
    teacher.full_name,
    s.name,
    s.region::text
  from public.ticket_messages m
  join public.tickets tk on tk.id = m.ticket_id
  left join public.profiles sender on sender.id = m.sender_id
  left join public.profiles teacher on teacher.id = tk.teacher_id
  left join public.schools s on s.id = tk.school_id
  order by tk.ticket_number, m.created_at;
$$;

comment on function public.ticket_messages_for_sheet() is
  'Every message on every ticket, internal notes included, in thread order. The Tickets tab measures this conversation; this is the conversation.';

revoke execute on function public.ticket_messages_for_sheet() from public, anon, authenticated;
grant execute on function public.ticket_messages_for_sheet() to service_role;
