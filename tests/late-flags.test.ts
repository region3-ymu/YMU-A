// Unit tests for classifyLateFlag(), which decides what an open
// late_clock_in flag actually says. The card used to show one undifferentiated
// list; these pin the three states apart, including the 15-minute boundary
// clock_in() (0044) uses to auto-resolve — anything at or under it should
// normally be gone before it reaches this module, so a row that survives here
// is a genuinely late arrival or a no-show.

import { describe, expect, it } from "vitest";
import {
  classifyLateFlag,
  describeLateFlag,
  needsChasing,
  type LateFlagInput,
} from "../src/lib/attendance/late-flags";

const NOW = Date.parse("2026-08-14T18:00:00.000Z");

function flag(over: Partial<LateFlagInput> & { start?: string; end?: string } = {}): LateFlagInput {
  return {
    clock_in_at: over.clock_in_at ?? null,
    event: {
      start_at: over.start ?? "2026-08-14T17:00:00.000Z",
      end_at: over.end ?? "2026-08-14T17:50:00.000Z",
    },
  };
}

describe("classifyLateFlag", () => {
  it("reports a teacher who turned up, with how late they were", () => {
    const state = classifyLateFlag(flag({ clock_in_at: "2026-08-14T17:11:00.000Z" }), NOW);
    expect(state).toEqual({ state: "arrived", minutesLate: 11 });
    expect(describeLateFlag(state)).toBe("Arrived 11 min late");
    expect(needsChasing(state)).toBe(false);
  });

  it("floors partial minutes rather than rounding up", () => {
    const state = classifyLateFlag(flag({ clock_in_at: "2026-08-14T17:11:59.000Z" }), NOW);
    expect(state).toEqual({ state: "arrived", minutesLate: 11 });
  });

  it("reports the 15-minute auto-resolve boundary as 15, not 16", () => {
    const state = classifyLateFlag(flag({ clock_in_at: "2026-08-14T17:15:00.000Z" }), NOW);
    expect(state).toEqual({ state: "arrived", minutesLate: 15 });
  });

  it("never reports negative lateness for an early arrival", () => {
    const state = classifyLateFlag(flag({ clock_in_at: "2026-08-14T16:55:00.000Z" }), NOW);
    expect(state).toEqual({ state: "arrived", minutesLate: 0 });
  });

  it("says 'arrived late' without a number when the class has no start time", () => {
    const input = { clock_in_at: "2026-08-14T17:11:00.000Z", event: { start_at: null, end_at: null } };
    expect(describeLateFlag(classifyLateFlag(input, NOW))).toBe("Arrived late");
  });

  it("distinguishes a teacher missing from a class still running", () => {
    const state = classifyLateFlag(flag({ end: "2026-08-14T18:30:00.000Z" }), NOW);
    expect(state).toEqual({ state: "absent", classEnded: false });
    expect(describeLateFlag(state)).toBe("Still not clocked in");
    expect(needsChasing(state)).toBe(true);
  });

  it("distinguishes a teacher who never came at all", () => {
    const state = classifyLateFlag(flag({ end: "2026-08-14T17:50:00.000Z" }), NOW);
    expect(state).toEqual({ state: "absent", classEnded: true });
    expect(describeLateFlag(state)).toBe("Never clocked in");
    expect(needsChasing(state)).toBe(true);
  });

  it("treats an unknown end time as still running rather than claiming a no-show", () => {
    const input = { clock_in_at: null, event: { start_at: "2026-08-14T17:00:00.000Z", end_at: null } };
    expect(classifyLateFlag(input, NOW)).toEqual({ state: "absent", classEnded: false });
  });

  it("treats a missing event the same way", () => {
    expect(classifyLateFlag({ clock_in_at: null, event: null }, NOW)).toEqual({
      state: "absent",
      classEnded: false,
    });
  });

  it("does not choke on an unparseable timestamp", () => {
    const input = { clock_in_at: "not a date", event: { start_at: "also not", end_at: "nope" } };
    expect(classifyLateFlag(input, NOW)).toEqual({ state: "arrived", minutesLate: null });
  });
});
