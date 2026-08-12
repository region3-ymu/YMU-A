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
  it("gives all time no bounds at all", () => {
    expect(resolveRange("all", YEARS, DURING_2026)).toEqual({ key: "all", label: "All time" });
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
  it("covers the final day of a school year", () => {
    const r = resolveRange("sy:y26", YEARS, DURING_2026);
    expect(r.from).toBe("2026-08-12T00:00:00.000Z");
    expect(r.to).toBe("2027-06-03T00:00:00.000Z");
    expect(r.label).toBe("2026-27");
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
