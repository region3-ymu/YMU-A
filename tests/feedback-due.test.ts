import { describe, expect, it } from "vitest";
import {
  describeDue,
  dueUrgency,
  feedbackDueAt,
  FEEDBACK_WINDOW_HOURS,
  isOverdue,
} from "../src/lib/attendance/feedback-due";

const HOUR = 60 * 60 * 1000;

describe("feedbackDueAt", () => {
  it("adds exactly 24 hours to the scheduled end", () => {
    const end = "2026-08-12T18:30:00.000Z";
    expect(feedbackDueAt(end)).toBe("2026-08-13T18:30:00.000Z");
  });

  it("returns null for a class with no scheduled end, so it can never block", () => {
    expect(feedbackDueAt(null)).toBeNull();
    expect(feedbackDueAt(undefined)).toBeNull();
    expect(feedbackDueAt("")).toBeNull();
  });

  it("returns null rather than an Invalid Date for junk input", () => {
    expect(feedbackDueAt("not a date")).toBeNull();
  });

  // The reason the whole module works in epoch ms rather than wall-clock. On
  // 2026-11-01 America/New_York falls back an hour; a window computed in local
  // time would be 25 hours here and 23 hours at the spring-forward boundary.
  it("is exactly 24 absolute hours across the autumn DST boundary", () => {
    const end = "2026-11-01T03:00:00.000Z"; // 11:00 PM EDT Oct 31, before the fallback
    const due = feedbackDueAt(end)!;
    expect(Date.parse(due) - Date.parse(end)).toBe(FEEDBACK_WINDOW_HOURS * HOUR);
  });

  it("is exactly 24 absolute hours across the spring DST boundary", () => {
    const end = "2026-03-08T05:00:00.000Z"; // midnight EST, just before spring forward
    const due = feedbackDueAt(end)!;
    expect(Date.parse(due) - Date.parse(end)).toBe(FEEDBACK_WINDOW_HOURS * HOUR);
  });
});

describe("isOverdue", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  it("is true once the deadline has passed", () => {
    expect(isOverdue("2026-08-12T11:59:00.000Z", now)).toBe(true);
  });

  it("is false while the deadline is still ahead", () => {
    expect(isOverdue("2026-08-12T12:01:00.000Z", now)).toBe(false);
  });

  // Mirrors the SQL predicate's `feedback_due_at is not null` guard. A null
  // deadline blocking would brick clock-in for anyone with one malformed row.
  it("is false for a null deadline", () => {
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue(undefined, now)).toBe(false);
  });
});

describe("dueUrgency", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  it("reports overdue past the deadline", () => {
    expect(dueUrgency("2026-08-12T10:00:00.000Z", now)).toBe("overdue");
  });

  it("reports soon inside the last two hours", () => {
    expect(dueUrgency("2026-08-12T13:30:00.000Z", now)).toBe("soon");
  });

  it("treats exactly two hours out as soon", () => {
    expect(dueUrgency("2026-08-12T14:00:00.000Z", now)).toBe("soon");
  });

  it("reports ok with more than two hours left", () => {
    expect(dueUrgency("2026-08-12T14:00:01.000Z", now)).toBe("ok");
  });

  it("reports none without a deadline", () => {
    expect(dueUrgency(null, now)).toBe("none");
  });
});

describe("describeDue", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  it("counts down in hours within two days", () => {
    expect(describeDue("2026-08-13T06:00:00.000Z", now)).toBe("Due in 18h");
  });

  it("counts down in minutes under an hour", () => {
    expect(describeDue("2026-08-12T12:45:00.000Z", now)).toBe("Due in 45m");
  });

  it("counts up once overdue", () => {
    expect(describeDue("2026-08-12T09:00:00.000Z", now)).toBe("Overdue by 3h");
  });

  it("switches to days past 48 hours", () => {
    expect(describeDue("2026-08-15T12:00:00.000Z", now)).toBe("Due in 3d");
  });

  it("avoids a bare 0m at the boundary", () => {
    expect(describeDue("2026-08-12T12:00:30.000Z", now)).toBe("Due in less than a minute");
  });

  it("says so when there is no deadline", () => {
    expect(describeDue(null, now)).toBe("No deadline");
  });
});
