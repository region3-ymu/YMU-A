// RLS-scoped reads for the Manager Dashboard widgets. Each one reuses an
// existing RLS-scoped table/view rather than inventing new SQL: open
// sessions (attendance_sessions), late escalations (flags, Phase 5),
// today's per-class attendance status (attendance_period_rows, this phase),
// and upcoming classes (calendar_events).

import { createClient } from "@/lib/supabase/server";

const DAY_MS = 24 * 60 * 60 * 1000;

// UTC day boundaries, matching this project's existing no-per-school-
// timezone convention (schedules/format.ts's dayKey, notify-dispatch's
// utcDateKey) rather than introducing local-time handling nothing else here
// has either.
function utcDayBounds(now: Date) {
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(startMs + DAY_MS).toISOString() };
}

export type OpenSessionRow = {
  id: string;
  teacher_id: string;
  clock_in_at: string;
  clock_in_status: "on_time" | "late";
  school: { name: string } | null;
  event: { summary: string | null } | null;
};

// Teachers clocked in right now. This used to serve the "pending feedback"
// widget as well, on Phase 4's "an open session IS the demand" model — but
// 0026 gave feedback its own 24-hour window and its own settled marker, so an
// open session and an owed feedback are now different things. Pending feedback
// reads getPendingFeedback() below instead.
//
// Deliberately does NOT embed profiles(full_name) for the teacher: a
// Regional Manager's profiles_select RLS gates on profiles.region, which is
// null-by-design for teachers (Phase 3 derives a teacher's region from their
// scheduled schools instead) — that embed would silently come back null for
// every teacher, rendering as "Unknown teacher" even for a correctly
// assigned one. The caller resolves the name via getReportRoster(), which
// scopes Regional Managers correctly (calendar_events -> schools.region).
export async function getOpenSessions(): Promise<OpenSessionRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select(
      "id, teacher_id, clock_in_at, clock_in_status, " +
        "school:schools(name), event:calendar_events(summary)",
    )
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false });
  return (data as unknown as OpenSessionRow[]) ?? [];
}

export type LateFlagRow = {
  id: string;
  teacher_id: string;
  created_at: string;
  school: { name: string } | null;
  event: { summary: string | null; start_at: string | null; end_at: string | null } | null;
  /** Null when the teacher still has not clocked in for this class. */
  clock_in_at: string | null;
};

/**
 * Open late-clock-in flags, each carrying whether the teacher has since
 * turned up.
 *
 * A flag is raised 5 minutes after start when no session exists, and until
 * now nothing distinguished "flagged, then walked in 11 minutes late" from
 * "flagged and never showed" — the card mixed both. clock_in() (0044) now
 * auto-resolves the flag when someone arrives inside the 15-minute grace, so
 * what survives here is either a genuinely absent teacher or an arrival late
 * enough to be worth a manager's attention. Either way the caller can label it.
 *
 * The session is looked up separately rather than embedded: flags.session_id
 * is null for this flag type by construction (there was no session when it was
 * raised), so the only link back is the (event_id, teacher_id) pair.
 *
 * Same reasoning as getOpenSessions() above: no profiles embed, teacher_id
 * only — resolve the name via getReportRoster() at render time.
 */
export async function getOpenLateFlags(): Promise<LateFlagRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("flags")
    .select(
      "id, teacher_id, event_id, created_at, " +
        "school:schools(name), event:calendar_events(summary, start_at, end_at)",
    )
    .eq("type", "late_clock_in")
    .is("resolved_at", null)
    .order("created_at", { ascending: false });

  const flags = (data as unknown as (LateFlagRow & { event_id: string | null })[]) ?? [];
  const eventIds = [...new Set(flags.map((f) => f.event_id).filter((id): id is string => Boolean(id)))];
  if (eventIds.length === 0) return flags.map((f) => ({ ...f, clock_in_at: null }));

  const { data: sessions } = await supabase
    .from("attendance_sessions")
    .select("event_id, teacher_id, clock_in_at")
    .in("event_id", eventIds);

  const clockInByKey = new Map(
    ((sessions as { event_id: string; teacher_id: string; clock_in_at: string }[] | null) ?? []).map((s) => [
      `${s.event_id}:${s.teacher_id}`,
      s.clock_in_at,
    ]),
  );

  return flags.map((f) => ({
    ...f,
    clock_in_at: f.event_id ? clockInByKey.get(`${f.event_id}:${f.teacher_id}`) ?? null : null,
  }));
}

export type PendingFeedbackRow = {
  id: string;
  teacher_id: string;
  feedback_due_at: string;
  school: { name: string } | null;
  event: { summary: string | null; start_at: string | null } | null;
};

/**
 * Every shift still owing a class feedback log, overdue or not.
 *
 * Replaces the old "stuck feedback sessions" widget, which read
 * `flags.type = 'feedback_stuck'` — a flag written by a detector that has no
 * cron entry and has never produced a single row, behind an empty state that
 * still talked about a Zoho webhook we no longer use.
 *
 * The predicate is deliberately the same one has_overdue_feedback() uses to
 * block clock-in (0026), minus the due-date comparison, so the dashboard and
 * the gate can never disagree about who owes what. The caller decides which
 * rows are overdue by comparing feedback_due_at to now.
 */
export async function getPendingFeedback(): Promise<PendingFeedbackRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select(
      "id, teacher_id, feedback_due_at, " +
        "school:schools(name), event:calendar_events(summary, start_at)",
    )
    .is("feedback_settled_at", null)
    .not("feedback_due_at", "is", null)
    .order("feedback_due_at", { ascending: true });
  return (data as unknown as PendingFeedbackRow[]) ?? [];
}

export type TodayAttendanceRow = {
  event_id: string;
  teacher_id: string;
  summary: string | null;
  start_at: string;
  end_at: string | null;
  attendance_status: "on_time" | "late" | "missed" | "upcoming";
};

// Today's per-(teacher, class) status, straight from attendance_period_rows
// — 'missed' rows are exactly the missing-clock-ins widget's data.
export async function getTodayAttendanceRows(): Promise<TodayAttendanceRow[]> {
  const supabase = await createClient();
  const { startIso, endIso } = utcDayBounds(new Date());
  const { data } = await supabase
    .from("attendance_period_rows")
    .select("event_id, teacher_id, summary, start_at, end_at, attendance_status")
    .gte("start_at", startIso)
    .lt("start_at", endIso);
  return (data as unknown as TodayAttendanceRow[]) ?? [];
}

export type CalendarSyncFailure = {
  calendar_id: string;
  last_error: string | null;
  updated_at: string;
};

// calendar_sync_state (0006/0018) — one row per synced calendar, written by
// the sync Edge Function on every run, success or failure. Reading only the
// error rows here (the widget just needs "is sync currently unhealthy").
export async function getCalendarSyncHealth(): Promise<CalendarSyncFailure[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("calendar_sync_state")
    .select("calendar_id, last_error, updated_at")
    .eq("last_status", "error")
    .order("updated_at", { ascending: false });
  return (data as unknown as CalendarSyncFailure[]) ?? [];
}

/**
 * Sends that genuinely broke in the last 24 hours.
 *
 * Computed in SQL rather than off notification_queue.status, because the
 * status alone cannot tell a broken send from a recipient who has no device.
 * On the first day of term that difference was 244 versus 15. 0043 further
 * pins "has a device" to each notification's own created_at — asking it as of
 * now() meant a teacher's entire pre-install backlog turned into real failures
 * the moment they installed the app (that is where the 97 came from).
 *
 * The RPC's second column (no_device_recipients) is deliberately ignored here:
 * getTeachersWithoutApp() answers that question against the roster instead.
 */
export async function getNotificationHealth(): Promise<{ realFailures: number }> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("notification_health", { p_hours: 24 });
  const row = (data as { real_failures: number }[] | null)?.[0];
  return { realFailures: row?.real_failures ?? 0 };
}

export type TeacherWithoutAppRow = {
  teacher_id: string;
  full_name: string;
  has_upcoming_classes: boolean;
};

/**
 * Teachers with no push subscription — the closest the schema gets to "has
 * not installed the app".
 *
 * push_subscriptions is RLS'd to own-rows-only, so this has to go through the
 * security-definer teachers_without_app() (0043), which scopes itself back
 * down with can_read_profile(). The old tile counted distinct recipients of a
 * failed notification in the last 24 hours instead, which drifted day to day,
 * missed anyone who had no class that day, and could count managers.
 */
export async function getTeachersWithoutApp(): Promise<TeacherWithoutAppRow[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("teachers_without_app");
  return (data as TeacherWithoutAppRow[] | null) ?? [];
}

export type UpcomingEventRow = {
  id: string;
  summary: string | null;
  start_at: string | null;
  teacher_ids: string[];
  school: { name: string } | null;
};

export async function getUpcomingClasses(limit = 10): Promise<UpcomingEventRow[]> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("calendar_events")
    .select("id, summary, start_at, teacher_ids, school:schools(name)")
    .neq("status", "cancelled")
    .eq("all_day", false)
    .gt("start_at", nowIso)
    .order("start_at", { ascending: true })
    .limit(limit);
  return (data as unknown as UpcomingEventRow[]) ?? [];
}
