// @ts-nocheck
// Pure decision logic for notify-dispatch, kept environment-agnostic (no Deno
// or Supabase imports) so it's unit-testable with plain vitest against
// synthetic data -- same "extract the pure decision function" pattern as
// classifyDiscoveredCalendar in supabase/functions/calendar-sync/sync.ts.
// index.ts is the thin Deno wrapper that fetches real rows, calls planDispatch,
// and performs the actual push/email sends this file only decides about.

// The one cross-boundary import, same pattern as calendar-sync/sync.ts pulling
// in the Google client: datetime.ts has zero imports of its own, so it loads
// cleanly under Deno. Worth the coupling to keep a single definition of "app
// time" — a second copy of the zone string is a second thing to forget.
import { APP_TIME_ZONE } from "../../../src/lib/format/datetime.ts";

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
//
// Manager-facing types (the last three) read the enriched payload that
// migration 0027 writes: teacher name and phone, school name, class summary
// and start time. Before that they said "A teacher hasn't clocked in for a
// scheduled class" and nothing else, which told a manager only that they
// should stop what they were doing and go look something up.
//
// Every field is optional on purpose. manager_notification_payload strips
// nulls, so an unmatched school or a deleted event yields fewer keys — and a
// thinner notification is the right degradation, since an unmatched-school
// class is exactly what a manager most needs to hear about.
export function notificationCopy(row: Pick<QueueRow, "type" | "payload">): {
  title: string;
  body: string;
  url: string;
} {
  const payload = row.payload ?? {};
  const summary = str(payload.summary) ?? "your class";

  switch (row.type) {
    case "be_there_soon":
      return { title: "Time to head over", body: `${summary} starts soon.`, url: "/clocking" };
    case "clock_in_reminder":
      return { title: "Don't forget to clock in", body: `${summary} has started.`, url: "/clocking" };
    case "clock_out_reminder":
      // Since 0026 clocking out and submitting feedback are separate, and this
      // reminder is about the feedback — the one with a deadline.
      return {
        title: "Feedback due",
        body: dueSuffix(payload) ?? `${summary} has ended.`,
        url: "/feedback",
      };
    case "time_changed":
      return { title: "Schedule changed", body: `${summary}'s time changed.`, url: "/schedules" };
    case "location_changed":
      return { title: "Schedule changed", body: `${summary}'s location changed.`, url: "/schedules" };
    case "teacher_changed":
      return { title: "Schedule changed", body: `${summary}'s teacher assignment changed.`, url: "/schedules" };
    case "event_cancelled":
      return { title: "Class cancelled", body: `${summary} was cancelled.`, url: "/schedules" };

    case "gps_out_of_fence": {
      const distance = num(payload.distance_m);
      const how = distance == null ? "outside the geofence" : `${Math.round(distance)}m away`;
      return {
        title: managerTitle("GPS check flagged", payload),
        body: managerBody(`${teacher(payload)} was ${how} during ${summary}`, payload),
        url: "/flags",
      };
    }
    case "late_clock_in":
      return {
        title: managerTitle("Missed clock-in", payload),
        body: managerBody(`${teacher(payload)} hasn't clocked in for ${summary}`, payload),
        url: "/flags",
      };
    case "feedback_stuck":
      return {
        title: managerTitle("Feedback overdue", payload),
        body: managerBody(`${teacher(payload)} hasn't submitted feedback for ${summary}`, payload),
        url: "/flags",
      };

    // Ticketing (migration 0030). The first two are manager-facing and reuse
    // the enriched payload; the last two go to the teacher, whose own name and
    // phone would be noise, so they stay short.
    case "ticket_opened":
      return {
        title: managerTitle("New ticket", payload),
        body: managerBody(`${teacher(payload)} raised a ${category(payload)} issue`, payload),
        url: ticketUrl(payload),
      };
    case "ticket_assigned":
      return {
        title: managerTitle("Ticket assigned to you", payload),
        body: managerBody(`${teacher(payload)}'s ${category(payload)} issue is now yours`, payload),
        url: ticketUrl(payload),
      };
    case "ticket_sla_breach":
      return {
        title: str(payload.escalated)
          ? managerTitle("Escalated — no reply in 24h", payload)
          : managerTitle("No reply in 24h", payload),
        body: managerBody(`${ticketRef(payload)} from ${teacher(payload)} has had no reply`, payload),
        url: ticketUrl(payload),
      };
    case "ticket_teacher_replied":
      return {
        title: managerTitle("Teacher replied", payload),
        body: managerBody(`${teacher(payload)} answered ${ticketRef(payload).toLowerCase()}`, payload),
        url: ticketUrl(payload),
      };
    case "ticket_needs_you":
      return {
        title: "Your ticket needs a reply",
        body: `${ticketRef(payload)} is waiting on you.`,
        url: ticketUrl(payload),
      };
    case "ticket_resolved":
      return {
        title: "Ticket resolved",
        body: `${ticketRef(payload)} was resolved. Reopen it if the problem is still there.`,
        url: ticketUrl(payload),
      };

    default:
      return { title: "YMU-A", body: summary, url: "/" };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function teacher(payload: Record<string, unknown>): string {
  return str(payload.teacher_name) ?? "A teacher";
}

function category(payload: Record<string, unknown>): string {
  return (str(payload.category_type) ?? "support").toLowerCase();
}

function ticketRef(payload: Record<string, unknown>): string {
  const n = num(payload.ticket_number);
  return n == null ? "Your ticket" : `Ticket #${n}`;
}

// Deep-links to the ticket when we know which one, so a manager lands on the
// thread rather than on a list they then have to search.
function ticketUrl(payload: Record<string, unknown>): string {
  const id = str(payload.ticket_id);
  return id ? `/tickets/${id}` : "/tickets";
}

// The school goes in the TITLE, not the body. A manager covering a region
// triages by site first, and Android/iOS both truncate the body long before
// the title on a locked screen.
function managerTitle(base: string, payload: Record<string, unknown>): string {
  const school = str(payload.school_name);
  return school ? `${base} — ${school}` : base;
}

// Time then phone, in that order: the time tells the manager whether this is
// still actionable, and the phone is what they do about it. Tapping a number
// in a notification dials on both platforms.
function managerBody(lead: string, payload: Record<string, unknown>): string {
  const parts = [lead];
  const startAt = str(payload.start_at);
  if (startAt) {
    const at = timeInAppZone(startAt);
    if (at) parts[0] = `${lead} at ${at}`;
  }
  const phone = str(payload.teacher_phone);
  return phone ? `${parts[0]}. Call ${phone}` : `${parts[0]}.`;
}

function dueSuffix(payload: Record<string, unknown>): string | undefined {
  const summary = str(payload.summary);
  const due = str(payload.due_at);
  if (!summary || !due) return undefined;
  const at = timeInAppZone(due);
  return at ? `Feedback for ${summary} is due by ${at}.` : undefined;
}

// This runs in Deno on Supabase's infrastructure, which is UTC. Rendering a
// bare time there would tell a Miami manager a class started four hours later
// than it did — the exact bug commit 2ad1c92 fixed on the web side. The zone
// is imported rather than repeated so there is one definition of "app time".
function timeInAppZone(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(new Date(ms));
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
