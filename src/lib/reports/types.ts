import type { Region } from "@/lib/auth/roles";

// Mirrors supabase/migrations/0016_reports.sql's attendance_period_rows view
// column-for-column. One row per (matched teacher, non-cancelled,
// school-matched class) — a session_id of null means the class was never
// clocked into.
export type ReportRow = {
  event_id: string;
  teacher_id: string;
  school_id: string;
  school_region: Region | null;
  summary: string | null;
  start_at: string;
  end_at: string | null;
  session_id: string | null;
  clock_in_status: "on_time" | "late" | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  origin: "online" | "offline" | null;
  attendance_status: "on_time" | "late" | "missed" | "upcoming";
  hours_worked: number | null;
};

export type SchoolYear = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  archived: boolean;
};

export type Granularity = "weekly" | "monthly" | "quarterly";

// One aggregated row: a teacher x period bucket. attendanceRatePct is null
// when scheduledCount is 0 (nothing to rate yet — e.g. an all-upcoming week).
export type PeriodSummary = {
  teacherId: string;
  periodKey: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  hoursWorked: number;
  onTimeCount: number;
  lateCount: number;
  missedCount: number;
  upcomingCount: number;
  scheduledCount: number;
  attendanceRatePct: number | null;
};

export type RosterTeacher = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  archived_at: string | null;
};
