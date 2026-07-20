// Pure unit tests for the on-time/late computation (no DB, no credentials).
// Mirrors the grace-window logic in public.clock_in().

import { describe, expect, it } from "vitest";
import {
  ON_TIME_GRACE_MINUTES,
  computeClockInStatus,
  minutesLate,
} from "../src/lib/attendance/status.ts";

const start = new Date("2026-07-20T15:00:00Z");
const plus = (mins: number) => new Date(start.getTime() + mins * 60_000);

describe("computeClockInStatus", () => {
  it("is on_time exactly at the scheduled start", () => {
    expect(computeClockInStatus(start, start)).toBe("on_time");
  });

  it("is on_time when early", () => {
    expect(computeClockInStatus(start, plus(-30))).toBe("on_time");
  });

  it("is on_time at the edge of the grace window", () => {
    expect(computeClockInStatus(start, plus(ON_TIME_GRACE_MINUTES))).toBe("on_time");
  });

  it("is late just past the grace window", () => {
    expect(computeClockInStatus(start, plus(ON_TIME_GRACE_MINUTES + 1))).toBe("late");
  });

  it("honours a custom grace window", () => {
    expect(computeClockInStatus(start, plus(9), 10)).toBe("on_time");
    expect(computeClockInStatus(start, plus(11), 10)).toBe("late");
  });

  it("treats an unscheduled class as on_time", () => {
    expect(computeClockInStatus(null, plus(120))).toBe("on_time");
  });
});

describe("minutesLate", () => {
  it("is 0 when early or unscheduled", () => {
    expect(minutesLate(start, plus(-5))).toBe(0);
    expect(minutesLate(null, plus(30))).toBe(0);
  });

  it("rounds minutes past the start", () => {
    expect(minutesLate(start, plus(12))).toBe(12);
  });
});
