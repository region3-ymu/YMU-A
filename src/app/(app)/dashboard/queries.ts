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
  teacher: { full_name: string } | null;
  school: { name: string } | null;
  event: { summary: string | null } | null;
};

// Every currently-open session IS a teacher clocked in right now AND owing
// feedback (Phase 4's "open session is the Demand") — one query serves both
// the "clocked in now" and "pending feedback" widgets.
export async function getOpenSessions(): Promise<OpenSessionRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select(
      "id, teacher_id, clock_in_at, clock_in_status, " +
        "teacher:profiles!attendance_sessions_teacher_id_fkey(full_name), " +
        "school:schools(name), event:calendar_events(summary)",
    )
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false });
  return (data as unknown as OpenSessionRow[]) ?? [];
}

export type LateFlagRow = {
  id: string;
  created_at: string;
  teacher: { full_name: string } | null;
  school: { name: string } | null;
  event: { summary: string | null; start_at: string | null } | null;
};

export async function getOpenLateFlags(): Promise<LateFlagRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("flags")
    .select(
      "id, created_at, teacher:profiles!flags_teacher_id_fkey(full_name), " +
        "school:schools(name), event:calendar_events(summary, start_at)",
    )
    .eq("type", "late_clock_in")
    .is("resolved_at", null)
    .order("created_at", { ascending: false });
  return (data as unknown as LateFlagRow[]) ?? [];
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
