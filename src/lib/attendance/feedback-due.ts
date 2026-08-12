// The 24-hour feedback window, in TypeScript.
//
// SQL is authoritative — has_overdue_feedback() in migration 0026 is what
// actually blocks a clock-in. This module is its twin for the UI, the same way
// status.ts's ON_TIME_GRACE_MINUTES mirrors clock_in()'s p_grace_minutes
// default. Keep the two in sync; if they ever disagree, SQL wins and the UI is
// the bug.
//
// Pure and dependency-free so it's unit-testable without a database.
//
// Everything here works in absolute time (epoch ms), never wall-clock. A
// 24-hour window computed in local time would be 23 or 25 hours across a DST
// boundary — America/New_York has two of those a year, and a teacher losing an
// hour of their window to a clock change is not a bug anyone would enjoy
// diagnosing. Rendering the resulting instant in Miami time is a separate
// concern, handled by lib/format/datetime.ts.

export const FEEDBACK_WINDOW_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The deadline for feedback on a class that was scheduled to end at `endAt`.
 * Null in, null out: a class with no scheduled end (an all-day event, an
 * admin-created row) has no deadline and never blocks.
 */
export function feedbackDueAt(endAt: string | null | undefined): string | null {
  if (!endAt) return null;
  const ms = Date.parse(endAt);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + FEEDBACK_WINDOW_HOURS * HOUR_MS).toISOString();
}

/** A null deadline never blocks — matches the SQL predicate exactly. */
export function isOverdue(dueAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!dueAt) return false;
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return false;
  return ms < now;
}

export type DueUrgency = "overdue" | "soon" | "ok" | "none";

/**
 * How hard to shout about a deadline. "soon" is the last two hours, which is
 * roughly one class period of warning — enough to act on, not so early that
 * every pending item looks urgent.
 */
export function dueUrgency(dueAt: string | null | undefined, now: number = Date.now()): DueUrgency {
  if (!dueAt) return "none";
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return "none";
  if (ms < now) return "overdue";
  return ms - now <= 2 * HOUR_MS ? "soon" : "ok";
}

/**
 * Short human phrase for a deadline chip: "Due in 18h", "Due in 45m",
 * "Overdue by 3h". Deliberately coarse — a countdown to the minute on a
 * 24-hour window is false precision, and a server-rendered one is stale the
 * moment it paints.
 */
export function describeDue(dueAt: string | null | undefined, now: number = Date.now()): string {
  if (!dueAt) return "No deadline";
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return "No deadline";

  const diff = ms - now;
  const overdue = diff < 0;
  const abs = Math.abs(diff);

  let amount: string;
  if (abs < MINUTE_MS) {
    amount = "less than a minute";
  } else if (abs < HOUR_MS) {
    amount = `${Math.round(abs / MINUTE_MS)}m`;
  } else if (abs < 48 * HOUR_MS) {
    amount = `${Math.round(abs / HOUR_MS)}h`;
  } else {
    amount = `${Math.round(abs / (24 * HOUR_MS))}d`;
  }

  return overdue ? `Overdue by ${amount}` : `Due in ${amount}`;
}
