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
  clock_in_status: "on_time" | "late" | "not_held" | "absent" | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  origin: "online" | "offline" | null;
  attendance_status: "on_time" | "late" | "not_held" | "absent" | "missed" | "upcoming";
  hours_worked: number | null;
};

export type SchoolYear = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  archived: boolean;
};

// "yearly" means SCHOOL year, not calendar year — consistent with
// "quarterly", which has always been 9-week blocks anchored to
// school_years.start_date. A calendar year would split every school year in
// half at Christmas, which is not a period anyone at YMU reasons about.
export type Granularity = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "9-week quarter",
  yearly: "School year",
};

export function isGranularity(value: string | undefined): value is Granularity {
  return value === "daily" || value === "weekly" || value === "monthly"
    || value === "quarterly" || value === "yearly";
}

// One aggregated row: a teacher x period bucket. attendanceRatePct is null
// when scheduledCount is 0 (nothing to rate yet — e.g. an all-upcoming week).
export type PeriodSummary = {
  teacherId: string;
  periodKey: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  hoursWorked: number;
  /**
   * Classes actually taught: on-time plus late. NOT scheduledCount, which
   * counts the missed ones too — a teacher who missed three of twenty taught
   * seventeen, and that is the number YMU reads alongside hours.
   *
   * Excludes notHeldCount. A cancelled class is still PAID, so it stays in
   * hoursWorked, but no lesson was delivered so it is not a class taught.
   * Separating the two is what stops one number having to mean both.
   */
  taughtCount: number;
  /**
   * Classes that did not happen. Paid (see hoursWorked) but not taught, and
   * shown beside taughtCount rather than folded into it or hidden.
   */
  notHeldCount: number;
  /**
   * Classes that DID happen but the assigned teacher did not show — unlike
   * notHeldCount, NOT paid (excluded from hoursWorked) and, unlike
   * notHeldCount, counted IN scheduledCount: this is a real failure to
   * attend, so it still counts against the attendance rate the same way
   * missedCount does. The difference from missedCount is only that it has an
   * actual record (reason, excused or not) instead of silence.
   */
  absentCount: number;
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
