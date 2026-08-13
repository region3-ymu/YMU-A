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

  it("switches to days past 24 hours", () => {
    expect(formatDuration(1440)).toBe("1d");
    expect(formatDuration(1740)).toBe("1d 5h");
    expect(formatDuration(4320)).toBe("3d");
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

  // Mirrors ticket_ttr_target_hours() in migration 0031. If SQL changes and
  // this doesn't, the screen would promise a deadline the database disagrees
  // with.
  it("mirrors the SQL resolution targets", () => {
    expect(TTR_TARGET_HOURS.Urgent).toBe(4);
    expect(TTR_TARGET_HOURS.High).toBe(24);
    expect(TTR_TARGET_HOURS.Normal).toBe(72);
  });
});
