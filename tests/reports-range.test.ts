// Unit tests for the report time window (lib/reports/range.ts) — the server-
// side half of the two-control design, as opposed to granularity, which is
// pure client-side bucketing. `now` is injected everywhere so the presets are
// testable without freezing the clock.

import { describe, expect, it } from "vitest";
import {
  currentSchoolYear,
  defaultRangeKey,
  rangeOptions,
  resolveRange,
} from "../src/lib/reports/range";
import { clampToDataStart, DATA_START_DATE, DATA_START_ISO } from "../src/lib/app-data-window";
import type { SchoolYear } from "../src/lib/reports/types";

const YEARS: SchoolYear[] = [
  { id: "y26", name: "2026-27", start_date: "2026-08-12", end_date: "2027-06-02", archived: false },
  { id: "y25", name: "2025-26", start_date: "2025-08-13", end_date: "2026-06-03", archived: true },
];

const DURING_2026 = Date.parse("2026-10-15T12:00:00Z");
const SUMMER_GAP = Date.parse("2026-07-01T12:00:00Z"); // after y25 ends, before y26 starts

describe("currentSchoolYear", () => {
  it("returns the year containing today", () => {
    expect(currentSchoolYear(YEARS, DURING_2026)?.id).toBe("y26");
  });

  // Summer is a real gap in school_years, and a report that renders nothing
  // for two months because "no year is active" is useless.
  it("falls back to the most recent past year during the summer gap", () => {
    expect(currentSchoolYear(YEARS, SUMMER_GAP)?.id).toBe("y25");
  });

  it("returns null when no school years exist at all", () => {
    expect(currentSchoolYear([], DURING_2026)).toBeNull();
  });
});

describe("defaultRangeKey", () => {
  // Quarters are defined as 9-week blocks anchored to a school year's
  // start_date, so "9-week quarter" grouping is meaningless outside one.
  it("defaults to the current school year when one exists", () => {
    expect(defaultRangeKey(YEARS, DURING_2026)).toBe("sy:y26");
  });

  it("falls back to a rolling window with no school years", () => {
    expect(defaultRangeKey([], DURING_2026)).toBe("90d");
  });
});

describe("resolveRange", () => {
  // "All time" means all the time this app has existed. Everything in
  // calendar_events before DATA_START_DATE is pre-pilot history swept in by
  // the first Google sync — thousands of classes nobody could have clocked
  // into, every one of which reads as a missed class.
  it("floors all time at the day the data starts", () => {
    expect(resolveRange("all", YEARS, DURING_2026)).toEqual({
      key: "all",
      label: `All time (from ${DATA_START_DATE})`,
      from: DATA_START_ISO,
      to: undefined,
    });
  });

  // The window ends at TOMORROW's UTC midnight, not at `now`. Classes later
  // today are still `upcoming` rows, and a window ending at this instant would
  // drop the rest of today from the report.
  it("includes the whole of today in a rolling window", () => {
    const r = resolveRange("30d", YEARS, DURING_2026);
    expect(r.to).toBe("2026-10-16T00:00:00.000Z");
    expect(r.from).toBe("2026-09-16T00:00:00.000Z");
  });

  // school_years.end_date is inclusive, so the bound has to reach the
  // following midnight or every class on the last day of the year vanishes.
  // The start is pulled forward to the data start — y26 begins 2026-08-12, one
  // day before the pilot went live — and the label says so, because a total
  // labelled "2026-27" that quietly omits a day would be worse than a longer
  // label.
  it("covers the final day of a school year, floored at the data start", () => {
    const r = resolveRange("sy:y26", YEARS, DURING_2026);
    expect(r.from).toBe(DATA_START_ISO);
    expect(r.to).toBe("2027-06-03T00:00:00.000Z");
    expect(r.label).toBe(`2026-27 (from ${DATA_START_DATE})`);
  });

  // A window entirely after the data start is left exactly as it was — the
  // floor must not relabel or move a range it does not affect.
  it("leaves a range that already starts later alone", () => {
    const r = resolveRange("30d", YEARS, DURING_2026);
    expect(r.from).toBe("2026-09-16T00:00:00.000Z");
    expect(r.label).toBe("Last 30 days");
  });

  // The case that prompted this: in the first weeks of the pilot a rolling
  // 30-day window reaches back into July, where 8,496 swept-in calendar events
  // sit with no attendance against them.
  it("clamps a rolling window that would reach behind the data start", () => {
    const earlyPilot = Date.parse("2026-08-20T12:00:00Z");
    const r = resolveRange("30d", YEARS, earlyPilot);
    expect(r.from).toBe(DATA_START_ISO);
    expect(r.to).toBe("2026-08-21T00:00:00.000Z");
    expect(r.label).toBe(`Last 30 days (from ${DATA_START_DATE})`);
  });

  it("falls back to the default for an unknown key", () => {
    expect(resolveRange("nonsense", YEARS, DURING_2026).key).toBe("sy:y26");
    expect(resolveRange("sy:does-not-exist", YEARS, DURING_2026).key).toBe("sy:y26");
  });

  it("uses the default when no key is supplied", () => {
    expect(resolveRange(undefined, YEARS, DURING_2026).key).toBe("sy:y26");
  });

  // The fallback path resolves the default, which could itself be unknown.
  // Guarding it is what stops that from recursing forever.
  it("terminates when even the default cannot resolve", () => {
    expect(resolveRange("nonsense", [], DURING_2026).key).toBe("90d");
  });
});

describe("rangeOptions", () => {
  it("lists rolling windows, then school years newest first, then all time", () => {
    expect(rangeOptions(YEARS)).toEqual([
      { key: "30d", label: "Last 30 days" },
      { key: "90d", label: "Last 90 days" },
      { key: "sy:y26", label: "2026-27" },
      { key: "sy:y25", label: "2025-26 (archived)" },
      { key: "all", label: "All time" },
    ]);
  });

  it("still offers the rolling windows with no school years", () => {
    expect(rangeOptions([]).map((o) => o.key)).toEqual(["30d", "90d", "all"]);
  });
});

describe("clampToDataStart", () => {
  it("treats no lower bound as the data start, not the beginning of time", () => {
    expect(clampToDataStart(undefined)).toBe(DATA_START_ISO);
  });

  it("pulls an earlier bound forward", () => {
    expect(clampToDataStart("2026-07-15T00:00:00.000Z")).toBe(DATA_START_ISO);
  });

  it("leaves a later bound untouched", () => {
    expect(clampToDataStart("2026-09-01T00:00:00.000Z")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("is a no-op exactly on the boundary", () => {
    expect(clampToDataStart(DATA_START_ISO)).toBe(DATA_START_ISO);
  });
});
