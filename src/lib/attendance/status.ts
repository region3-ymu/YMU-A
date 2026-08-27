// On-time / late computation for clock-in.
//
// TypeScript twin of the CASE expression in public.clock_in()
// (supabase/migrations/0008_attendance.sql). Kept in sync deliberately: this
// one runs client-side to *preview* the status the moment a teacher gets a GPS
// fix; the RPC computes and stores the authoritative value on the session.

// The ±5-minute grace window. Single source of truth for the default so
// "configurable" means changing one constant (and the RPC's p_grace_minutes
// default) rather than hunting inline literals; a per-school/global override
// UI is a later concern.
export const ON_TIME_GRACE_MINUTES = 5;

// What COMPUTING a clock-in can produce. Deliberately not widened for
// 'not_held': a clock-in is a teacher arriving, and there is no punctuality to
// judge for a class that did not happen. Nothing here can ever return it.
export type AttendanceStatus = "on_time" | "late";

/**
 * What a session's clock_in_status can be once STORED, which is a wider set.
 * A manager recording a class as class_not_held writes 'not_held' (migration
 * 0087) — it still pays, because hours come from the class's scheduled length,
 * but it is not a class taught and no arrival time is being claimed.
 */
export type SessionStatus = AttendanceStatus | "not_held";

// Late only when the clock-in is MORE than `graceMinutes` after the scheduled
// start. Arriving early (or with no scheduled start to be late against) is
// on-time — matches the RPC's `now() > start_at + grace` test.
export function computeClockInStatus(
  scheduledStart: Date | null,
  clockInAt: Date,
  graceMinutes: number = ON_TIME_GRACE_MINUTES,
): AttendanceStatus {
  if (!scheduledStart) return "on_time";
  const lateByMs = clockInAt.getTime() - scheduledStart.getTime();
  return lateByMs > graceMinutes * 60_000 ? "late" : "on_time";
}

// Whole minutes past the scheduled start (0 if early / unscheduled). For UI
// copy like "12 min late"; not used for the on_time/late decision itself.
export function minutesLate(
  scheduledStart: Date | null,
  clockInAt: Date,
): number {
  if (!scheduledStart) return 0;
  return Math.max(
    0,
    Math.round((clockInAt.getTime() - scheduledStart.getTime()) / 60_000),
  );
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  on_time: "On time",
  late: "Late",
  not_held: "Class did not happen",
};
