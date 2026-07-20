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

export type AttendanceStatus = "on_time" | "late";

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

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  on_time: "On time",
  late: "Late",
};
