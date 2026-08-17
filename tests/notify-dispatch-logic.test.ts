// Unit tests for notify-dispatch's pure planDispatch()/notificationCopy() —
// preference gating, the 100/day email trickle cap, and max-attempts
// backoff. Synthetic rows only, no network/DB involved, same pattern as
// tests/calendar-sync-classify.test.ts.

import { describe, expect, it } from "vitest";
import {
  EMAIL_DAILY_CAP,
  MAX_PUSH_ATTEMPTS,
  notificationCopy,
  planDispatch,
  type QueueRow,
} from "../supabase/functions/notify-dispatch/dispatch-logic.ts";

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: overrides.id ?? "row-1",
    recipient_id: overrides.recipient_id ?? "user-1",
    event_id: overrides.event_id ?? "event-1",
    type: overrides.type ?? "be_there_soon",
    payload: overrides.payload ?? { summary: "Drumline" },
    status: overrides.status ?? "pending",
    email_status: overrides.email_status ?? null,
    attempts: overrides.attempts ?? 0,
    created_at: overrides.created_at ?? "2026-07-21T12:00:00.000Z",
  };
}

const alwaysEnabled = () => ({ enabled: true });

describe("planDispatch", () => {
  it("sends push for a pending, non-email-eligible type and never attempts email", () => {
    const [decision] = planDispatch([row({ type: "be_there_soon" })], {
      isPreferenceEnabled: alwaysEnabled,
      emailSentToday: 0,
    });
    expect(decision.sendPush).toBe(true);
    expect(decision.sendEmail).toBe(false);
  });

  it("sends both push and email for an email-eligible type with email_status pending", () => {
    const [decision] = planDispatch(
      [row({ type: "event_cancelled", email_status: "pending" })],
      { isPreferenceEnabled: alwaysEnabled, emailSentToday: 0 },
    );
    expect(decision.sendPush).toBe(true);
    expect(decision.sendEmail).toBe(true);
  });

  it("skips both channels entirely when the recipient disabled that preference type", () => {
    const [decision] = planDispatch(
      [row({ type: "clock_out_reminder", email_status: "pending" })],
      { isPreferenceEnabled: () => ({ enabled: false }), emailSentToday: 0 },
    );
    expect(decision.sendPush).toBe(false);
    expect(decision.sendEmail).toBe(false);
    expect(decision.skipReason).toBe("disabled_by_preference");
  });

  it("never skips push for gps_out_of_fence/late_clock_in — no Settings toggle exists for them", () => {
    const rows = [row({ type: "gps_out_of_fence" }), row({ type: "late_clock_in", id: "row-2" })];
    const decisions = planDispatch(rows, {
      // A preference lookup that would disable everything, to prove it's never even consulted.
      isPreferenceEnabled: () => ({ enabled: false }),
      emailSentToday: 0,
    });
    expect(decisions.every((d) => d.sendPush)).toBe(true);
    expect(decisions.every((d) => !d.sendEmail)).toBe(true); // not email-eligible types
  });

  it("never emails be_there_soon or clock_in_reminder even if email_status were somehow set", () => {
    const rows = [
      row({ type: "be_there_soon", email_status: "pending" }),
      row({ type: "clock_in_reminder", email_status: "pending", id: "row-2" }),
    ];
    const decisions = planDispatch(rows, { isPreferenceEnabled: alwaysEnabled, emailSentToday: 0 });
    expect(decisions.every((d) => !d.sendEmail)).toBe(true);
  });

  it("trickles a mass fan-out across the daily cap, oldest-first, FIFO within one run", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `row-${i}`, type: "event_cancelled", email_status: "pending", created_at: `2026-07-21T12:00:0${i}.000Z` }),
    );
    const decisions = planDispatch(rows, {
      isPreferenceEnabled: alwaysEnabled,
      emailSentToday: EMAIL_DAILY_CAP - 3, // only 3 slots left today
    });
    const emailed = decisions.filter((d) => d.sendEmail).map((d) => d.row.id);
    expect(emailed).toEqual(["row-0", "row-1", "row-2"]);
    const skipped = decisions.filter((d) => !d.sendEmail);
    expect(skipped.every((d) => d.skipReason === "email_cap_reached" || d.row.email_status !== "pending")).toBe(true);
    // Push is unaffected by the email cap — every row still gets pushed.
    expect(decisions.every((d) => d.sendPush)).toBe(true);
  });

  it("sends nothing by email once the daily cap is already exhausted", () => {
    const decisions = planDispatch([row({ type: "event_cancelled", email_status: "pending" })], {
      isPreferenceEnabled: alwaysEnabled,
      emailSentToday: EMAIL_DAILY_CAP,
    });
    expect(decisions[0].sendEmail).toBe(false);
    expect(decisions[0].skipReason).toBe("email_cap_reached");
  });

  it("stops retrying push past MAX_PUSH_ATTEMPTS", () => {
    const [decision] = planDispatch([row({ attempts: MAX_PUSH_ATTEMPTS })], {
      isPreferenceEnabled: alwaysEnabled,
      emailSentToday: 0,
    });
    expect(decision.sendPush).toBe(false);
    expect(decision.skipReason).toBe("max_attempts");
  });

  it("does not re-send push for a row already marked sent or failed", () => {
    const decisions = planDispatch(
      [row({ status: "sent" }), row({ status: "failed", id: "row-2" })],
      { isPreferenceEnabled: alwaysEnabled, emailSentToday: 0 },
    );
    expect(decisions.every((d) => !d.sendPush)).toBe(true);
  });
});

describe("notificationCopy", () => {
  it("produces distinct, non-empty copy for every known type", () => {
    const types = [
      "be_there_soon",
      "clock_in_reminder",
      "clock_out_reminder",
      "time_changed",
      "location_changed",
      "teacher_changed",
      "event_cancelled",
      "gps_out_of_fence",
      "late_clock_in",
    ];
    // gps_out_of_fence/late_clock_in are manager-facing and deliberately
    // don't echo the class summary (they're about a teacher/school, not a
    // specific class the manager would recognize by name).
    const noSummaryTypes = new Set(["gps_out_of_fence", "late_clock_in"]);
    const seen = new Set<string>();
    for (const type of types) {
      const copy = notificationCopy({ type, payload: { summary: "Modern Band" } });
      expect(copy.title.length).toBeGreaterThan(0);
      if (!noSummaryTypes.has(type)) expect(copy.body).toContain("Modern Band");
      seen.add(copy.title + copy.url);
    }
    expect(seen.size).toBeGreaterThanOrEqual(7); // schedule_changed's 3 sub-types may legitimately share a title
  });

  it("falls back gracefully for an unknown type or missing payload summary", () => {
    const copy = notificationCopy({ type: "made_up_type", payload: {} });
    expect(copy.title).toBeTruthy();
    expect(copy.body).toBeTruthy();
  });

  // Announcements board, migration 0053.
  it("deep-links a news announcement to the post", () => {
    const copy = notificationCopy({
      type: "news_published",
      payload: { post_id: "9f1d0f4e-1c2b-4a3d-8e5f-6a7b8c9d0e1f", title: "Cover needed Thursday" },
    });
    expect(copy.title).toBe("New announcement");
    expect(copy.body).toBe("Cover needed Thursday");
    expect(copy.url).toBe("/news/9f1d0f4e-1c2b-4a3d-8e5f-6a7b8c9d0e1f");
  });

  it("still lands on the board when a news payload has no post id", () => {
    expect(notificationCopy({ type: "news_published", payload: { title: "Hi" } }).url).toBe("/news");
  });

  // create_news_post() writes the headline into `summary` as well as `title`,
  // so a notify-dispatch build that predates the case above still shows
  // something meaningful instead of an empty push.
  it("degrades to the headline on an older dispatcher build", () => {
    const copy = notificationCopy({ type: "made_up_type", payload: { summary: "Cover needed" } });
    expect(copy.body).toBe("Cover needed");
  });
});

describe("notificationCopy — manager-facing detail (migration 0027)", () => {
  const full = {
    teacher_name: "James Perez",
    teacher_phone: "305-555-0142",
    school_name: "Madison Middle School",
    summary: "Drumline",
    start_at: "2026-08-12T16:30:00Z", // 12:30 PM in Miami
  };

  // The school goes in the TITLE: a manager covering a region triages by site
  // first, and both platforms truncate the body long before the title.
  it("puts the school in the title and the who/what/when/phone in the body", () => {
    const copy = notificationCopy({ type: "late_clock_in", payload: { ...full, flag_id: "f1" } });
    expect(copy.title).toBe("Missed clock-in — Madison Middle School");
    expect(copy.body).toBe(
      "James Perez hasn't clocked in for Drumline at 12:30 PM. Call 305-555-0142",
    );
    expect(copy.url).toBe("/flags");
  });

  // The exact bug commit 2ad1c92 fixed on the web side. This code runs in Deno
  // on Supabase's UTC infrastructure, so an unpinned zone would render 4:30 PM
  // for a 12:30 PM Miami class.
  it("renders the start time in Miami time, not the runtime's zone", () => {
    const copy = notificationCopy({ type: "late_clock_in", payload: full });
    expect(copy.body).toContain("12:30 PM");
    expect(copy.body).not.toContain("4:30 PM");
  });

  it("reports the distance for an out-of-fence GPS check", () => {
    const copy = notificationCopy({
      type: "gps_out_of_fence",
      payload: { ...full, distance_m: 812 },
    });
    expect(copy.title).toBe("GPS check flagged — Madison Middle School");
    expect(copy.body).toBe("James Perez was 812m away during Drumline at 12:30 PM. Call 305-555-0142");
  });

  // feedback_stuck previously fell through to the default branch and shipped
  // managers a push reading "YMU-A / your class".
  it("no longer falls through to the generic default", () => {
    const copy = notificationCopy({ type: "feedback_stuck", payload: full });
    expect(copy.title).toBe("Feedback overdue — Madison Middle School");
    expect(copy.body).toContain("James Perez hasn't submitted feedback for Drumline");
    expect(copy.url).toBe("/flags");
  });

  // manager_notification_payload strips nulls, so a thin payload is normal —
  // an unmatched-school class is exactly what a manager most needs to hear
  // about, and it must not be the case that produces "undefined" in the text.
  it("degrades cleanly when the payload is missing fields", () => {
    const copy = notificationCopy({ type: "late_clock_in", payload: { flag_id: "f1" } });
    expect(copy.title).toBe("Missed clock-in");
    expect(copy.body).toBe("A teacher hasn't clocked in for your class.");
    expect(copy.body).not.toContain("undefined");
  });

  it("omits the phone rather than inventing one", () => {
    const copy = notificationCopy({
      type: "late_clock_in",
      payload: { teacher_name: "James Perez", summary: "Drumline" },
    });
    expect(copy.body).toBe("James Perez hasn't clocked in for Drumline.");
  });

  it("ignores an unparseable start time instead of printing Invalid Date", () => {
    const copy = notificationCopy({
      type: "late_clock_in",
      payload: { ...full, start_at: "not a date" },
    });
    expect(copy.body).toBe("James Perez hasn't clocked in for Drumline. Call 305-555-0142");
  });
});

describe("notificationCopy — clock_out_reminder after 0026", () => {
  // The reminder is about feedback now, which is the thing with a deadline;
  // clocking out happens on its own.
  it("names the feedback deadline when the payload carries one", () => {
    const copy = notificationCopy({
      type: "clock_out_reminder",
      payload: { summary: "Drumline", due_at: "2026-08-13T20:30:00Z" },
    });
    expect(copy.title).toBe("Feedback due");
    expect(copy.body).toBe("Feedback for Drumline is due by 4:30 PM.");
    expect(copy.url).toBe("/feedback");
  });

  it("falls back to the old wording for a queue row enqueued before 0026", () => {
    const copy = notificationCopy({ type: "clock_out_reminder", payload: { summary: "Drumline" } });
    expect(copy.body).toBe("Drumline has ended.");
  });
});

describe("notificationCopy — ticketing (migration 0030)", () => {
  const managerPayload = {
    teacher_name: "James Perez",
    teacher_phone: "305-555-0142",
    school_name: "Madison Middle School",
    summary: "Drumline",
    start_at: "2026-08-12T16:30:00Z",
    ticket_id: "11111111-2222-3333-4444-555555555555",
    category_type: "Operational",
  };

  it("names who, where and how to reach them for a new ticket", () => {
    const copy = notificationCopy({ type: "ticket_opened", payload: managerPayload });
    expect(copy.title).toBe("New ticket — Madison Middle School");
    expect(copy.body).toBe(
      "James Perez raised a operational issue at 12:30 PM. Call 305-555-0142",
    );
  });

  // Deep-links so a manager lands on the thread instead of a list to search.
  it("links straight to the ticket", () => {
    expect(notificationCopy({ type: "ticket_opened", payload: managerPayload }).url).toBe(
      "/tickets/11111111-2222-3333-4444-555555555555",
    );
  });

  it("falls back to the list when the id is missing", () => {
    expect(notificationCopy({ type: "ticket_assigned", payload: {} }).url).toBe("/tickets");
  });

  // Teacher-facing: their own name and phone would be noise, so these stay
  // short and reference the ticket number instead.
  it("keeps the teacher's own notifications short", () => {
    const copy = notificationCopy({
      type: "ticket_needs_you",
      payload: { ticket_id: "abc", ticket_number: 42 },
    });
    expect(copy.title).toBe("Your ticket needs a reply");
    expect(copy.body).toBe("Ticket #42 is waiting on you.");
  });

  it("tells the teacher a ticket was resolved and that reopening is possible", () => {
    const copy = notificationCopy({ type: "ticket_resolved", payload: { ticket_number: 7 } });
    expect(copy.body).toContain("Ticket #7 was resolved");
    expect(copy.body).toContain("Reopen");
  });

  it("degrades without a ticket number rather than printing undefined", () => {
    const copy = notificationCopy({ type: "ticket_resolved", payload: {} });
    expect(copy.body).toContain("Your ticket");
    expect(copy.body).not.toContain("undefined");
  });
});

// Escalating clock-in nudges, migration 0054. The whole point is that the
// third reminder does not read like the first — identical repeats are what
// teach people to ignore notifications.
describe("notificationCopy — clock-in nudges", () => {
  const base = { summary: "Modern Band", start_at: "2026-08-17T16:00:00.000Z" };

  it("is gentle on the first nudge", () => {
    const copy = notificationCopy({ type: "clock_in_reminder", payload: { ...base, nudge: "1" } });
    expect(copy.title).toBe("Don't forget to clock in");
    expect(copy.url).toBe("/clocking");
  });

  it("says how late they are on the second", () => {
    const copy = notificationCopy({
      type: "clock_in_reminder",
      payload: { ...base, nudge: "2", minutes_late: 5 },
    });
    expect(copy.title).toBe("Still not clocked in");
    expect(copy.body).toContain("5 minutes ago");
  });

  it("warns that the manager can see it on the last", () => {
    const copy = notificationCopy({
      type: "clock_in_reminder",
      payload: { ...base, nudge: "3", minutes_late: 10 },
    });
    expect(copy.title).toBe("Last reminder — clock in");
    expect(copy.body).toContain("manager");
  });

  // A row queued before 0054 has no nudge at all.
  it("treats a missing nudge as the first", () => {
    const copy = notificationCopy({ type: "clock_in_reminder", payload: base });
    expect(copy.title).toBe("Don't forget to clock in");
  });

  it("never repeats the same wording across the ladder", () => {
    const titles = ["1", "2", "3"].map(
      (nudge) => notificationCopy({ type: "clock_in_reminder", payload: { ...base, nudge } }).title,
    );
    expect(new Set(titles).size).toBe(3);
  });
});
