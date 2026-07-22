// Pure weekly/monthly/quarterly bucketing + hours/rate math over
// attendance_period_rows. Deliberately pure and dependency-free (no date
// library) so it's directly unit-testable against a seeded dataset without
// touching the DB — see tests/reports-aggregate.test.ts.
//
// Weekly/monthly buckets use UTC day boundaries, matching the existing
// UTC-day-key convention already used elsewhere in this codebase
// (schedules/format.ts's dayKey, notify-dispatch's utcDateKey) rather than
// introducing per-school timezone handling, which nothing else here has.
// Quarterly buckets are 9-week (63-day) blocks anchored to each school
// year's start_date (product requirement) — a class whose date falls
// outside every known school_years range lands in a "No school year"
// bucket rather than being silently dropped.

import { findSchoolYearForDate } from "../school-years/derive";
import type { Granularity, PeriodSummary, ReportRow, SchoolYear } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUARTER_DAYS = 63;

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Monday-start week containing ms.
function weekStart(ms: number): number {
  const midnight = utcMidnight(ms);
  const dow = new Date(midnight).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  return midnight - daysSinceMonday * DAY_MS;
}

function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function monthEnd(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
}

function monthLabel(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

type QuarterBounds = {
  schoolYearId: string;
  quarterNumber: number;
  periodStart: number;
  periodEnd: number;
};

function quarterBoundsFor(ms: number, schoolYears: SchoolYear[]): QuarterBounds | null {
  const dateKey = isoDate(ms);
  const year = findSchoolYearForDate(dateKey, schoolYears);
  if (!year) return null;

  const startMs = Date.parse(`${year.start_date}T00:00:00Z`);
  const endMs = Date.parse(`${year.end_date}T00:00:00Z`);
  const dayIndex = Math.floor((utcMidnight(ms) - startMs) / DAY_MS);
  const quarterNumber = Math.floor(dayIndex / QUARTER_DAYS) + 1;
  const periodStart = startMs + (quarterNumber - 1) * QUARTER_DAYS * DAY_MS;
  const periodEnd = Math.min(periodStart + (QUARTER_DAYS - 1) * DAY_MS, endMs);
  return { schoolYearId: year.id, quarterNumber, periodStart, periodEnd };
}

type Bucket = {
  teacherId: string;
  label: string;
  periodStart: number;
  periodEnd: number;
  rows: ReportRow[];
};

// combineTeachers=true merges every teacher into one set of totals per
// period (the OM/CPO master report's "All teachers (combined)" section and
// an RM's un-drilled "All teachers in my region" view) instead of the
// default one-bucket-per-teacher-per-period grouping the per-teacher
// sections use.
export function bucketReportRows(
  rows: ReportRow[],
  granularity: Granularity,
  schoolYears: SchoolYear[] = [],
  combineTeachers = false,
): PeriodSummary[] {
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    if (!row.start_at) continue;
    const startMs = Date.parse(row.start_at);
    const teacherKey = combineTeachers ? "all" : row.teacher_id;
    let periodStart: number;
    let periodEnd: number;
    let label: string;
    let key: string;

    if (granularity === "weekly") {
      periodStart = weekStart(startMs);
      periodEnd = periodStart + 6 * DAY_MS;
      key = `${teacherKey}:w:${isoDate(periodStart)}`;
      label = `Week of ${isoDate(periodStart)}`;
    } else if (granularity === "monthly") {
      periodStart = monthStart(startMs);
      periodEnd = monthEnd(startMs);
      key = `${teacherKey}:m:${isoDate(periodStart)}`;
      label = monthLabel(periodStart);
    } else {
      const bounds = quarterBoundsFor(startMs, schoolYears);
      if (bounds) {
        periodStart = bounds.periodStart;
        periodEnd = bounds.periodEnd;
        key = `${teacherKey}:q:${bounds.schoolYearId}:${bounds.quarterNumber}`;
        label = `Quarter ${bounds.quarterNumber}`;
      } else {
        periodStart = utcMidnight(startMs);
        periodEnd = periodStart;
        key = `${teacherKey}:q:none`;
        label = "No school year";
      }
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { teacherId: teacherKey, label, periodStart, periodEnd, rows: [] };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
  }

  const summaries = Array.from(buckets.entries()).map(([key, bucket]) => summarize(key, bucket));
  summaries.sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.teacherId.localeCompare(b.teacherId));
  return summaries;
}

function summarize(key: string, bucket: Bucket): PeriodSummary {
  let hoursWorked = 0;
  let onTime = 0;
  let late = 0;
  let missed = 0;
  let upcoming = 0;

  for (const row of bucket.rows) {
    if (row.hours_worked != null) hoursWorked += row.hours_worked;
    if (row.attendance_status === "on_time") onTime += 1;
    else if (row.attendance_status === "late") late += 1;
    else if (row.attendance_status === "missed") missed += 1;
    else upcoming += 1;
  }

  const scheduledCount = onTime + late + missed;

  return {
    teacherId: bucket.teacherId,
    periodKey: key,
    periodLabel: bucket.label,
    periodStart: isoDate(bucket.periodStart),
    periodEnd: isoDate(bucket.periodEnd),
    hoursWorked: Math.round(hoursWorked * 100) / 100,
    onTimeCount: onTime,
    lateCount: late,
    missedCount: missed,
    upcomingCount: upcoming,
    scheduledCount,
    attendanceRatePct:
      scheduledCount > 0 ? Math.round(((onTime + late) / scheduledCount) * 1000) / 10 : null,
  };
}
