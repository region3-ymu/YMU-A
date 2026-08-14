// Unit tests for the Schedules window (lib/schedules/range.ts). Pure, with
// `now` injected, so the presets and the Miami day boundary are pinned without
// a database or a frozen clock.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_RANGE,
  resolveScheduleRange,
  scheduleRangeOptions,
  startOfLocalDay,
} from "../src/lib/schedules/range";

// 2026-08-14 21:00 UTC = 5:00 PM in Miami (EDT, UTC-4).
const AFTERNOON = Date.parse("2026-08-14T21:00:00.000Z");
// 2026-08-15 02:00 UTC is still 10:00 PM on the 14th in Miami — the case that
// made evening classes group under the wrong day.
const LATE_EVENING = Date.parse("2026-08-15T02:00:00.000Z");

describe("startOfLocalDay", () => {
  it("is midnight in Miami, not in UTC", () => {
    expect(new Date(startOfLocalDay(AFTERNOON)).toISOString()).toBe("2026-08-14T04:00:00.000Z");
  });

  it("still belongs to the 14th at 10pm Miami time", () => {
    expect(new Date(startOfLocalDay(LATE_EVENING)).toISOString()).toBe("2026-08-14T04:00:00.000Z");
  });

  it("rolls over at Miami midnight, not UTC midnight", () => {
    // 04:00Z on the 15th is exactly midnight in Miami.
    const justAfter = Date.parse("2026-08-15T04:00:01.000Z");
    expect(new Date(startOfLocalDay(justAfter)).toISOString()).toBe("2026-08-15T04:00:00.000Z");
  });

  it("handles winter, when Miami is UTC-5", () => {
    const january = Date.parse("2027-01-20T18:00:00.000Z"); // 1pm EST
    expect(new Date(startOfLocalDay(january)).toISOString()).toBe("2027-01-20T05:00:00.000Z");
  });
});

describe("resolveScheduleRange", () => {
  it("defaults to the next 7 days", () => {
    const r = resolveScheduleRange(undefined, AFTERNOON);
    expect(r.key).toBe(DEFAULT_SCHEDULE_RANGE);
    expect(r.key).toBe("week");
    expect(r.from).toBe("2026-08-14T04:00:00.000Z");
    expect(r.to).toBe("2026-08-21T04:00:00.000Z");
  });

  it("covers the whole of today, not just what is left of it", () => {
    const r = resolveScheduleRange("today", AFTERNOON);
    expect(r.from).toBe("2026-08-14T04:00:00.000Z");
    expect(r.to).toBe("2026-08-15T04:00:00.000Z");
  });

  it("gives 30 days for the month preset", () => {
    const r = resolveScheduleRange("month", AFTERNOON);
    expect(r.to).toBe("2026-09-13T04:00:00.000Z");
  });

  it("falls back to the default on an unknown key rather than throwing", () => {
    expect(resolveScheduleRange("nonsense", AFTERNOON).key).toBe("week");
    expect(resolveScheduleRange(null, AFTERNOON).key).toBe("week");
  });

  it("labels every preset", () => {
    for (const option of scheduleRangeOptions()) {
      expect(resolveScheduleRange(option.key, AFTERNOON).label).toBe(option.label);
    }
  });
});
