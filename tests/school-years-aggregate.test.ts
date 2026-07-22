// Pure unit tests for src/lib/school-years/derive.ts (no DB, no credentials).
// findSchoolYearForDate is also exercised indirectly by
// tests/reports-aggregate.test.ts via quarterBoundsFor — these tests cover it
// directly, plus getActiveSchoolYear's "exclude archived" behavior that
// aggregate.ts never needed.

import { describe, expect, it } from "vitest";
import { findSchoolYearForDate, getActiveSchoolYear } from "../src/lib/school-years/derive.ts";
import type { SchoolYear } from "../src/lib/reports/types.ts";

function year(overrides: Partial<SchoolYear>): SchoolYear {
  return {
    id: "year",
    name: "Year",
    start_date: "2026-08-01",
    end_date: "2027-06-01",
    archived: false,
    ...overrides,
  };
}

describe("findSchoolYearForDate", () => {
  it("finds a non-archived year whose range contains the date", () => {
    const y = year({ id: "y1" });
    expect(findSchoolYearForDate("2026-09-15", [y])?.id).toBe("y1");
  });

  it("still resolves a date inside an archived year — archiving doesn't affect historical lookups", () => {
    const y = year({ id: "y1", archived: true });
    expect(findSchoolYearForDate("2026-09-15", [y])?.id).toBe("y1");
  });

  it("returns null when no year's range contains the date", () => {
    const y = year({ id: "y1", start_date: "2026-08-01", end_date: "2027-06-01" });
    expect(findSchoolYearForDate("2025-01-01", [y])).toBeNull();
  });

  it("matches range boundaries inclusively", () => {
    const y = year({ id: "y1", start_date: "2026-08-01", end_date: "2027-06-01" });
    expect(findSchoolYearForDate("2026-08-01", [y])?.id).toBe("y1");
    expect(findSchoolYearForDate("2027-06-01", [y])?.id).toBe("y1");
  });

  it("when two years' ranges both contain the date, returns the first match in array order", () => {
    const y1 = year({ id: "y1", start_date: "2026-08-01", end_date: "2027-06-01" });
    const y2 = year({ id: "y2", start_date: "2026-01-01", end_date: "2026-12-31" });
    expect(findSchoolYearForDate("2026-09-01", [y1, y2])?.id).toBe("y1");
    expect(findSchoolYearForDate("2026-09-01", [y2, y1])?.id).toBe("y2");
  });
});

describe("getActiveSchoolYear", () => {
  it("returns the non-archived year containing today", () => {
    const y = year({ id: "y1", start_date: "2026-08-01", end_date: "2027-06-01" });
    const today = new Date("2026-09-15T00:00:00Z");
    expect(getActiveSchoolYear([y], today)?.id).toBe("y1");
  });

  it("excludes an archived year even if its range contains today", () => {
    const y = year({ id: "y1", start_date: "2026-08-01", end_date: "2027-06-01", archived: true });
    const today = new Date("2026-09-15T00:00:00Z");
    expect(getActiveSchoolYear([y], today)).toBeNull();
  });

  it("returns null when no non-archived year contains today", () => {
    const y = year({ id: "y1", start_date: "2020-08-01", end_date: "2021-06-01" });
    const today = new Date("2026-09-15T00:00:00Z");
    expect(getActiveSchoolYear([y], today)).toBeNull();
  });
});
