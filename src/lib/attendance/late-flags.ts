// Reading an open late_clock_in flag.
//
// The flag is raised by detect_late_clockins() 5 minutes after a class starts
// when no attendance session exists. Until 0044 nothing ever closed it, so the
// dashboard's "Late clock-ins" card and the /flags page held two completely
// different situations under one heading: teachers who walked in a few minutes
// later, and teachers who never came at all. On 2026-08-14, 9 of 20 open flags
// were the first kind.
//
// clock_in() now auto-resolves the flag when someone arrives within 15 minutes
// of the start, so what reaches this module is either a notably late arrival
// or a genuine absence. This says which, in one place, for every surface that
// renders those flags.
//
// Pure and dependency-free so it's unit-testable without a database. `now` is
// a parameter with a default rather than a bare Date.now() at the call site:
// server components may not call impure functions during render.

export type LateFlagState =
  | { state: "arrived"; minutesLate: number | null }
  | { state: "absent"; classEnded: boolean };

export type LateFlagInput = {
  /** Null when the teacher still has no attendance session for this class. */
  clock_in_at: string | null;
  event: { start_at: string | null; end_at: string | null } | null;
};

export function classifyLateFlag(flag: LateFlagInput, now: number = Date.now()): LateFlagState {
  if (flag.clock_in_at) {
    return { state: "arrived", minutesLate: minutesLate(flag.event?.start_at, flag.clock_in_at) };
  }
  const endMs = flag.event?.end_at ? Date.parse(flag.event.end_at) : NaN;
  // An unknown or unparseable end time is treated as "still running": saying
  // "never clocked in" about a class that might still be going would be a
  // stronger claim than the data supports.
  return { state: "absent", classEnded: !Number.isNaN(endMs) && endMs < now };
}

/** The chip text. */
export function describeLateFlag(state: LateFlagState): string {
  if (state.state === "arrived") {
    return state.minutesLate === null ? "Arrived late" : `Arrived ${state.minutesLate} min late`;
  }
  return state.classEnded ? "Never clocked in" : "Still not clocked in";
}

/**
 * Whether this flag still needs someone to do something.
 *
 * A teacher who has not appeared is the one a manager can still call. A late
 * arrival is a record, not a task — it is on the card for context and sorts
 * below the absences.
 */
export function needsChasing(state: LateFlagState): boolean {
  return state.state === "absent";
}

function minutesLate(startAt: string | null | undefined, clockInAt: string): number | null {
  if (!startAt) return null;
  const start = Date.parse(startAt);
  const arrived = Date.parse(clockInAt);
  if (Number.isNaN(start) || Number.isNaN(arrived)) return null;
  return Math.max(0, Math.floor((arrived - start) / 60_000));
}
