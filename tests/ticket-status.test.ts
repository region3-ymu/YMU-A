// Unit tests for the pure ticket-status helpers. The SLA arithmetic itself
// lives in SQL (the ticket_sla view) on purpose — PRD 4.3 requires an agent
// and an Admin to see identical numbers, and two implementations drift. What
// is testable here is the presentation.

import { describe, expect, it } from "vitest";
import {
  formatDuration,
  OPEN_STATUSES,
  SLA_LABELS,
  STATUS_LABELS,
  TICKET_STATUSES,
  BUSINESS_DAY_HOURS,
  TTR_TARGET_HOURS,
} from "../src/lib/tickets/status";

describe("formatDuration", () => {
  it("uses minutes under an hour", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(59)).toBe("59m");
  });

  it("uses hours, with minutes only when they are not zero", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(150)).toBe("2h 30m");
  });

  // Every caller feeds this WORKING minutes (ticket_sla and friends, since
  // migration 0055), so a "day" is the nine-hour working day — not 24 hours.
  // Dividing by 24 printed a three-working-day ticket as "1d 3h", which is the
  // right elapsed-hours arithmetic and a meaningless number in a queue.
  it("switches to nine-hour working days", () => {
    expect(formatDuration(9 * 60)).toBe("1d");
    expect(formatDuration(14 * 60)).toBe("1d 5h");
    // The Normal resolution target: 27 working hours = three working days.
    expect(formatDuration(27 * 60)).toBe("3d");
  });

  it("still uses hours right up to the end of a working day", () => {
    expect(formatDuration(8 * 60 + 59)).toBe("8h 59m");
  });

  // A ticket answered within seconds must not read "0m", which looks like a
  // bug rather than an achievement.
  it("says 'just now' rather than 0m", () => {
    expect(formatDuration(0)).toBe("just now");
    expect(formatDuration(0.4)).toBe("just now");
  });

  // Null is "not measured yet" — an unanswered ticket has no first-response
  // time, and rendering that as 0 would claim an instant reply.
  it("renders a dash for a missing value", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });
});

describe("status vocabulary", () => {
  it("labels every status the database accepts", () => {
    for (const status of TICKET_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
  });

  // Closed is now the ONLY status needing nobody's attention — Resolved was
  // folded into it in 0040, since the two described the same act. The inbox's
  // default filter depends on this being exactly right.
  it("treats every status except Closed as needing action", () => {
    expect(OPEN_STATUSES).toHaveLength(TICKET_STATUSES.length - 1);
    expect(OPEN_STATUSES).not.toContain("Closed");
    // Every open status is a real one, and nothing open is missing.
    for (const status of TICKET_STATUSES) {
      if (status === "Closed") continue;
      expect(OPEN_STATUSES).toContain(status);
    }
  });

  // The two statuses YMU removed must not creep back through a stale import or
  // a copy-pasted literal: both had behaviour attached (Pending_Teacher paused
  // the SLA clock, Resolved carried the root-cause requirement) that now lives
  // on On_Hold and Closed instead.
  it("no longer knows Pending_Teacher or Resolved", () => {
    expect(TICKET_STATUSES).not.toContain("Pending_Teacher");
    expect(TICKET_STATUSES).not.toContain("Resolved");
  });

  it("labels every SLA state", () => {
    for (const state of ["on_track", "warning", "breached", "met", "missed"] as const) {
      expect(SLA_LABELS[state]).toBeTruthy();
    }
  });

  // Mirrors ticket_ttr_target_hours(), re-scaled in migration 0057. If SQL
  // changes and this doesn't, the screen would promise a deadline the database
  // disagrees with.
  //
  // These are WORKING hours (0055), which is the whole reason they moved: at a
  // nine-hour day the old 24/72 meant two and a half and eight working days.
  it("mirrors the SQL resolution targets, in working hours", () => {
    expect(TTR_TARGET_HOURS.Urgent).toBe(4);
    expect(TTR_TARGET_HOURS.High).toBe(9);
    expect(TTR_TARGET_HOURS.Normal).toBe(27);
  });

  // The point of the re-scale: each target is a round number of working days.
  it("expresses every target as whole working days", () => {
    expect(TTR_TARGET_HOURS.High / BUSINESS_DAY_HOURS).toBe(1);
    expect(TTR_TARGET_HOURS.Normal / BUSINESS_DAY_HOURS).toBe(3);
    // Urgent is deliberately less than a day — same working day, not next.
    expect(TTR_TARGET_HOURS.Urgent).toBeLessThan(BUSINESS_DAY_HOURS);
  });
});
