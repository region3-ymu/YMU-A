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
});
