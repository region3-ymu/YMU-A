-- Phase 4: Clocking flow + feedback gate.
--
-- One table, attendance_sessions: a row is created at clock-in and closed at
-- clock-out. There is deliberately NO separate "feedback demand" table
-- (user-confirmed): an OPEN session (clock_out_at IS NULL) *is* the blocking
-- obligation. Submitting feedback and clocking out are the same atomic action
-- (clock_out_with_feedback below), so you can never clock out without giving
-- feedback, and you can never clock into a new class while a session is still
-- open. See DECISIONS.md ("The open session is the Demand").
--
-- All mutations go through two SECURITY DEFINER RPCs (clock_in,
-- clock_out_with_feedback) — same pattern as promote_user / assign_event_school:
-- authenticated users have no INSERT/UPDATE grant on the table, so the RPCs'
-- own role/geo/state checks are the entire authorization story. The geofence
-- check is done SERVER-SIDE here with the existing haversine_meters() (the TS
-- twin in src/lib/geo/haversine.ts only drives the live "move closer" UI).

-- ---------------------------------------------------------------------------
-- attendance_sessions
-- ---------------------------------------------------------------------------

create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  -- The class being clocked into. Kept even if the event is later re-synced
  -- away (on delete set null) so the attendance record survives.
  event_id uuid references public.calendar_events (id) on delete set null,
  school_id uuid references public.schools (id) on delete set null,

  -- Clock-in: precise server timestamp + the GPS fix that passed the fence.
  clock_in_at timestamptz not null default now(),
  clock_in_lat double precision,
  clock_in_lng double precision,
  clock_in_accuracy_m double precision,
  -- Server-computed haversine distance from the school at clock-in (metres).
  clock_in_distance_m double precision,
  -- 'on_time' | 'late', computed against the class start ± the grace window.
  clock_in_status text not null,
  -- Snapshot of the event's scheduled start at clock-in time, so clock_in_status
  -- stays auditable even if the event is later edited/moved by a calendar sync.
  scheduled_start_at timestamptz,

  -- NULL => session is OPEN => feedback owed => clock-in blocked. Set only by
  -- clock_out_with_feedback, atomically with the feedback columns below.
  clock_out_at timestamptz,

  -- In-app feedback (the clock-out gate). Populated only at clock-out.
  feedback_rating smallint,
  feedback_summary text,
  feedback_challenges text,
  feedback_students_present integer,
  feedback_submitted_at timestamptz,
  -- Forward-compat: the product decision is to export each submission to Zoho
  -- after the fact (a later phase builds the exporter). Unused in Phase 4.
  zoho_synced_at timestamptz,

  -- Idempotency key from the client, so a double-tapped Clock-In (or an
  -- offline replay in a later phase) creates one session, not two.
  client_key uuid unique,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attendance_clock_in_status_check
    check (clock_in_status in ('on_time', 'late')),
  constraint attendance_feedback_rating_range
    check (feedback_rating is null or feedback_rating between 1 and 5),
  constraint attendance_students_present_nonneg
    check (feedback_students_present is null or feedback_students_present >= 0)
);

comment on table public.attendance_sessions is
  'One clock-in -> clock-out cycle. clock_out_at IS NULL means the session is open and feedback is owed; that open row is the blocking "Demand" (no separate table). Written only by clock_in()/clock_out_with_feedback().';

-- At most ONE open session per teacher — enforces "can''t clock in while a
-- previous class is unfinished" at the database level, not just in the RPC.
create unique index attendance_one_open_session_per_teacher
  on public.attendance_sessions (teacher_id)
  where clock_out_at is null;

create index attendance_sessions_teacher_idx on public.attendance_sessions (teacher_id);
create index attendance_sessions_school_idx on public.attendance_sessions (school_id);
create index attendance_sessions_event_idx on public.attendance_sessions (event_id);
create index attendance_sessions_clock_in_idx on public.attendance_sessions (clock_in_at);

create trigger attendance_sessions_touch_updated_at
  before update on public.attendance_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: teachers read their own sessions; managers read by region (same shape
-- as calendar_events_select) for Phase 8 reporting. No authenticated writes —
-- everything goes through the two RPCs below.
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions enable row level security;
revoke all on table public.attendance_sessions from anon, authenticated;
grant select on table public.attendance_sessions to authenticated;
grant all on table public.attendance_sessions to service_role;

create policy attendance_sessions_select on public.attendance_sessions
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.current_app_role() in ('operations_manager', 'cpo')
    or (
      public.current_app_role() = 'regional_manager'
      and (
        school_id is null
        or exists (
          select 1 from public.schools s
          where s.id = attendance_sessions.school_id
            and (s.region is null or s.region = public.current_app_region())
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- clock_in: the authoritative clock-in. Verifies the caller is a matched
-- teacher for the class, that they have no open session, that they are inside
-- the school's geofence (server-side haversine), then records a precise
-- timestamped session with on_time/late status. Raises a friendly message on
-- any denial; the client maps/repeats these.
-- ---------------------------------------------------------------------------

create or replace function public.clock_in(
  p_event_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null,
  p_client_key uuid default null,
  p_grace_minutes integer default 5
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event public.calendar_events%rowtype;
  v_school public.schools%rowtype;
  v_distance double precision;
  v_status text;
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to clock in.';
  end if;

  -- Idempotent replay: same client_key => return the existing session.
  if p_client_key is not null then
    select * into v_row
    from public.attendance_sessions
    where client_key = p_client_key and teacher_id = v_uid;
    if found then
      return v_row;
    end if;
  end if;

  select * into v_event from public.calendar_events where id = p_event_id;
  if not found then
    raise exception 'That class could not be found.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'That class has been cancelled.';
  end if;
  if not (v_uid = any (v_event.teacher_ids)) then
    raise exception 'You are not assigned to that class.';
  end if;

  if exists (
    select 1 from public.attendance_sessions
    where teacher_id = v_uid and clock_out_at is null
  ) then
    raise exception 'Submit feedback for your previous class before clocking in again.';
  end if;

  if v_event.school_id is null then
    raise exception 'This class has no matched school yet, so its location can''t be verified.';
  end if;
  select * into v_school from public.schools where id = v_event.school_id;
  if v_school.lat is null or v_school.lng is null then
    raise exception 'This school has no saved location yet — ask a manager to set it.';
  end if;

  v_distance := public.haversine_meters(p_lat, p_lng, v_school.lat, v_school.lng);
  if v_distance > v_school.geofence_radius_m then
    raise exception 'You are % m from %, outside the % m clock-in zone. Move closer and try again.',
      round(v_distance)::text, v_school.name, v_school.geofence_radius_m;
  end if;

  v_status := case
    when v_event.start_at is not null
     and now() > v_event.start_at + make_interval(mins => p_grace_minutes)
    then 'late'
    else 'on_time'
  end;

  insert into public.attendance_sessions (
    teacher_id, event_id, school_id,
    clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
    clock_in_status, scheduled_start_at, client_key
  ) values (
    v_uid, v_event.id, v_event.school_id,
    p_lat, p_lng, p_accuracy_m, v_distance,
    v_status, v_event.start_at, p_client_key
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer) from public, anon;
grant execute on function public.clock_in(uuid, double precision, double precision, double precision, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- clock_out_with_feedback: the ONLY way to close a session. Submitting the
-- feedback form and clocking out are one transaction, so clock-out is gated by
-- feedback by construction. clock_out_at is stamped at submission time.
-- ---------------------------------------------------------------------------

create or replace function public.clock_out_with_feedback(
  p_session_id uuid,
  p_rating integer,
  p_summary text,
  p_challenges text default null,
  p_students_present integer default null
)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance_sessions;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit feedback.';
  end if;

  select * into v_row from public.attendance_sessions where id = p_session_id;
  if not found or v_row.teacher_id <> v_uid then
    raise exception 'That clock-in session could not be found.';
  end if;
  if v_row.clock_out_at is not null then
    raise exception 'You have already clocked out of this class.';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Please rate the class from 1 to 5.';
  end if;
  if p_summary is null or btrim(p_summary) = '' then
    raise exception 'Please describe how the class went.';
  end if;
  if p_students_present is not null and p_students_present < 0 then
    raise exception 'Students present can''t be negative.';
  end if;

  update public.attendance_sessions
     set clock_out_at = now(),
         feedback_rating = p_rating,
         feedback_summary = btrim(p_summary),
         feedback_challenges = nullif(btrim(coalesce(p_challenges, '')), ''),
         feedback_students_present = p_students_present,
         feedback_submitted_at = now()
   where id = p_session_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.clock_out_with_feedback(uuid, integer, text, text, integer) from public, anon;
grant execute on function public.clock_out_with_feedback(uuid, integer, text, text, integer) to authenticated;
