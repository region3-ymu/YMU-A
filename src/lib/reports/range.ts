// The time window a report covers, as opposed to how it is grouped.
//
// These are two independent questions and the app conflated them until now:
// "group by week" said nothing about *which* weeks, so /reports fetched every
// row the caller could see and bucketed all of it. For an OM that is every
// class of every teacher for the whole school year, growing unbounded, and
// getReportRows() has accepted from/to since 0016 without a single caller ever
// passing them.
//
// Granularity stays client-side (switching it is pure math over rows already
// in the browser). The range has to be server-side because it bounds the
// query, so it travels in the URL like `teacher` does.
//
// Pure and dependency-free, so the presets are unit-testable without a DB —
// and `now` is injectable for the same reason.

import { clampToDataStart, DATA_START_DATE } from "../app-data-window";
import { findSchoolYearForDate } from "../school-years/derive";
import type { SchoolYear } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReportRange = {
  key: string;
  label: string;
  /** Inclusive lower bound, ISO instant. Undefined means "no lower bound". */
  from?: string;
  /** Exclusive-ish upper bound, ISO instant. Undefined means "no upper bound". */
  to?: string;
};

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function lastNDays(n: number, now: number): { from: string; to: string } {
  // Ends at tomorrow's UTC midnight so today's classes — including ones later
  // today that are still `upcoming` — are inside the window. A window ending
  // at "now" would silently drop the rest of today.
  const end = utcMidnight(now) + DAY_MS;
  return { from: new Date(end - n * DAY_MS).toISOString(), to: new Date(end).toISOString() };
}

function schoolYearRange(year: SchoolYear): { from: string; to: string } {
  return {
    from: `${year.start_date}T00:00:00.000Z`,
    // end_date is inclusive in school_years, so push to the following midnight
    // rather than dropping every class on the last day of the year.
    to: new Date(Date.parse(`${year.end_date}T00:00:00.000Z`) + DAY_MS).toISOString(),
  };
}

/**
 * The school year containing `now`, or the most recent one if today falls in a
 * gap (summer). Null when no school years exist at all.
 */
export function currentSchoolYear(schoolYears: SchoolYear[], now: number = Date.now()): SchoolYear | null {
  const today = isoDate(now);
  const active = findSchoolYearForDate(today, schoolYears);
  if (active) return active;
  const past = schoolYears
    .filter((y) => y.end_date < today)
    .sort((a, b) => b.end_date.localeCompare(a.end_date));
  return past[0] ?? null;
}

export function defaultRangeKey(schoolYears: SchoolYear[], now: number = Date.now()): string {
  const year = currentSchoolYear(schoolYears, now);
  // A school year is the better default when one exists: quarters are defined
  // against it, so "9-week quarter" grouping is meaningless outside one.
  return year ? `sy:${year.id}` : "90d";
}

// No `now` parameter: the option LIST is the same whenever you ask. Only
// resolveRange turns a key into bounds, and that is where the clock matters.
export function rangeOptions(schoolYears: SchoolYear[]): { key: string; label: string }[] {
  const years = schoolYears
    .slice()
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .map((y) => ({ key: `sy:${y.id}`, label: y.archived ? `${y.name} (archived)` : y.name }));
  return [
    { key: "30d", label: "Last 30 days" },
    { key: "90d", label: "Last 90 days" },
    ...years,
    { key: "all", label: "All time" },
  ];
}

/**
 * Turns a range key into concrete bounds. An unknown or missing key falls back
 * to the default rather than erroring — a stale bookmark or a hand-edited URL
 * should render a report, not a crash.
 */
export function resolveRange(
  key: string | undefined,
  schoolYears: SchoolYear[],
  now: number = Date.now(),
): ReportRange {
  return floorAtDataStart(resolveRangeUnclamped(key, schoolYears, now));
}

/**
 * No range may reach behind the day the app's data starts.
 *
 * "Last 30 days" in August 2026 otherwise reaches into July, where 8,496
 * swept-in calendar events sit with no attendance against them — so the report
 * was mostly phantom missed classes. Applied to every preset including "All
 * time", which here means "all the time this app has existed".
 *
 * attendance_period_rows enforces the same floor in SQL, so this is about
 * honest labels and not fetching rows that would be discarded anyway.
 */
function floorAtDataStart(range: ReportRange): ReportRange {
  const from = clampToDataStart(range.from);
  const clamped = from !== range.from;
  return {
    ...range,
    from,
    label: clamped ? `${range.label} (from ${DATA_START_DATE})` : range.label,
  };
}

function resolveRangeUnclamped(
  key: string | undefined,
  schoolYears: SchoolYear[],
  now: number = Date.now(),
): ReportRange {
  const effective = key ?? defaultRangeKey(schoolYears, now);

  if (effective === "all") return { key: "all", label: "All time" };

  if (effective === "30d") return { key: "30d", label: "Last 30 days", ...lastNDays(30, now) };
  if (effective === "90d") return { key: "90d", label: "Last 90 days", ...lastNDays(90, now) };

  if (effective.startsWith("sy:")) {
    const year = schoolYears.find((y) => y.id === effective.slice(3));
    if (year) return { key: effective, label: year.name, ...schoolYearRange(year) };
  }

  // Unknown key. Resolve the default, but only once — if the default is itself
  // unresolvable we would otherwise recurse forever.
  const fallback = defaultRangeKey(schoolYears, now);
  if (fallback !== effective) return resolveRangeUnclamped(fallback, schoolYears, now);
  return { key: "all", label: "All time" };
}
