// @ts-nocheck
// Pure decision logic for notify-dispatch, kept environment-agnostic (no Deno
// or Supabase imports) so it's unit-testable with plain vitest against
// synthetic data -- same "extract the pure decision function" pattern as
// classifyDiscoveredCalendar in supabase/functions/calendar-sync/sync.ts.
// index.ts is the thin Deno wrapper that fetches real rows, calls planDispatch,
// and performs the actual push/email sends this file only decides about.

export type PreferenceType =
  | "be_there_soon"
  | "clock_in_reminder"
  | "clock_out_reminder"
  | "schedule_changed"
  | "class_cancelled";

// Maps notification_queue's raw `type` column to the coarser, user-facing
// preference Settings shows one toggle for. 'schedule_changed' covers all
// three of Phase 3's change-detection types; the three reminder types this
// phase introduces map 1:1 to their own preference. gps_out_of_fence/
// late_clock_in (Phase 5, manager-facing) have no entry at all -- there's no
// Settings toggle for them, so they're never skipped for preference reasons
// (see isEnabled below).
export const NOTIFICATION_TYPE_TO_PREFERENCE: Record<string, PreferenceType | undefined> = {
  time_changed: "schedule_changed",
  location_changed: "schedule_changed",
  teacher_changed: "schedule_changed",
  event_cancelled: "class_cancelled",
  be_there_soon: "be_there_soon",
  clock_in_reminder: "clock_in_reminder",
  clock_out_reminder: "clock_out_reminder",
};

// Types that also get a Resend email backup (brief: "schedule changes,
// cancellations, and clock-out reminders only" -- NOT be_there_soon,
// clock_in_reminder, or the two manager-facing Phase 5 types).
export const EMAIL_ELIGIBLE_TYPES = new Set([
  "time_changed",
  "location_changed",
  "teacher_changed",
  "event_cancelled",
  "clock_out_reminder",
]);

// Mirrored in supabase/migrations/0014_notifications.sql's
// enqueue_reminder_notifications() coalesce() defaults -- keep in sync.
export const DEFAULT_LEAD_MINUTES: Partial<Record<PreferenceType, number>> = {
  be_there_soon: 15,
  clock_in_reminder: 0,
  clock_out_reminder: 0,
};

// A push attempt that has failed this many times stops retrying (marked
// 'failed') rather than hammering a dead endpoint forever.
export const MAX_PUSH_ATTEMPTS = 5;

// Resend's free-tier daily send cap. Deliberately NOT per-recipient -- one
// shared budget across every email this run, oldest-queued-first, so a mass
// fan-out (e.g. one calendar edit touching many teachers) trickles across
// however many days it takes rather than bursting past the cap on day one.
export const EMAIL_DAILY_CAP = 100;

export type QueueRow = {
  id: string;
  recipient_id: string;
  event_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string; // push-channel status: 'pending' | 'sent' | 'failed'
  email_status: string | null; // null | 'pending' | 'sent' | 'failed'
  attempts: number;
  created_at: string;
};

export type PreferenceRow = { enabled: boolean };
export type PreferenceLookup = (recipientId: string, type: PreferenceType) => PreferenceRow | undefined;

export type DispatchDecision = {
  row: QueueRow;
  sendPush: boolean;
  sendEmail: boolean;
  skipReason?: "disabled_by_preference" | "max_attempts" | "email_cap_reached";
};

// Decides, for each candidate row, whether to send push and/or email this
// run. Pure and synchronous -- given the same inputs it always returns the
// same plan. `rows` MUST be passed oldest-created-first so the email cap's
// trickle is FIFO (the same class-change notification queued for 300
// teachers gets ~100 emailed today, the rest tomorrow, in the order they were
// queued -- not whichever 100 happen to be fetched first).
export function planDispatch(
  rows: QueueRow[],
  opts: {
    isPreferenceEnabled: PreferenceLookup;
    emailSentToday: number;
    emailDailyCap?: number;
  },
): DispatchDecision[] {
  const cap = opts.emailDailyCap ?? EMAIL_DAILY_CAP;
  let emailBudget = Math.max(0, cap - opts.emailSentToday);

  return rows.map((row) => {
    const prefType = NOTIFICATION_TYPE_TO_PREFERENCE[row.type];
    const enabled = prefType ? (opts.isPreferenceEnabled(row.recipient_id, prefType)?.enabled ?? true) : true;

    if (!enabled) {
      return { row, sendPush: false, sendEmail: false, skipReason: "disabled_by_preference" as const };
    }

    const pushEligible = row.status === "pending";
    const sendPush = pushEligible && row.attempts < MAX_PUSH_ATTEMPTS;

    const emailEligible = row.email_status === "pending" && EMAIL_ELIGIBLE_TYPES.has(row.type);
    let sendEmail = false;
    let skipReason: DispatchDecision["skipReason"];
    if (emailEligible) {
      if (emailBudget > 0) {
        sendEmail = true;
        emailBudget -= 1;
      } else {
        skipReason = "email_cap_reached";
      }
    }
    if (!sendPush && pushEligible && row.attempts >= MAX_PUSH_ATTEMPTS) {
      skipReason = "max_attempts";
    }

    return { row, sendPush, sendEmail, skipReason };
  });
}

// Human-facing copy, keyed by notification_queue's raw type. Kept here (not
// in index.ts) so a copy typo is caught by the same unit tests as the
// routing logic.
export function notificationCopy(row: Pick<QueueRow, "type" | "payload">): {
  title: string;
  body: string;
  url: string;
} {
  const payload = row.payload ?? {};
  const summary = typeof payload.summary === "string" && payload.summary ? payload.summary : "your class";

  switch (row.type) {
    case "be_there_soon":
      return { title: "Time to head over", body: `${summary} starts soon.`, url: "/clocking" };
    case "clock_in_reminder":
      return { title: "Don't forget to clock in", body: `${summary} has started.`, url: "/clocking" };
    case "clock_out_reminder":
      return { title: "Clock out & submit feedback", body: `${summary} has ended.`, url: "/feedback" };
    case "time_changed":
      return { title: "Schedule changed", body: `${summary}'s time changed.`, url: "/schedules" };
    case "location_changed":
      return { title: "Schedule changed", body: `${summary}'s location changed.`, url: "/schedules" };
    case "teacher_changed":
      return { title: "Schedule changed", body: `${summary}'s teacher assignment changed.`, url: "/schedules" };
    case "event_cancelled":
      return { title: "Class cancelled", body: `${summary} was cancelled.`, url: "/schedules" };
    case "gps_out_of_fence":
      return { title: "GPS check flagged", body: "A teacher's GPS check landed outside the fence.", url: "/flags" };
    case "late_clock_in":
      return { title: "Missed clock-in", body: "A teacher hasn't clocked in for a scheduled class.", url: "/flags" };
    default:
      return { title: "YMU-A", body: summary, url: "/" };
  }
}

// The "today" boundary for the email cap. UTC, matching Postgres's
// `current_date` default timezone on this project (no per-school timezone
// handling anywhere else in the app either) -- documented as a known caveat
// (a school just west of the UTC day boundary could see its cap reset a few
// hours off from its local midnight), not something worth solving for a
// 100/day free-tier cap.
export function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}
