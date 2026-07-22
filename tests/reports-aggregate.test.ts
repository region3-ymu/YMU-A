// Pure unit tests for weekly/monthly/quarterly bucketing + the hours/rate
// math (no DB, no credentials). This is the "reconcile against raw
// attendance rows" logic itself — tests/reports-rls.test.ts separately
// confirms the SQL view feeding it is scoped/authorized correctly.

import { describe, expect, it } from "vitest";
import { bucketReportRows } from "../src/lib/reports/aggregate.ts";
import type { ReportRow, SchoolYear } from "../src/lib/reports/types.ts";

function row(overrides: Partial<ReportRow>): ReportRow {
  return {
    event_id: "event",
    teacher_id: "teacher-1",
    school_id: "school",
    school_region: "central",
    summary: "Class",
    start_at: "2026-01-05T15:00:00Z",
    end_at: "2026-01-05T16:00:00Z",
    session_id: null,
    clock_in_status: null,
    clock_in_at: null,
    clock_out_at: null,
    origin: null,
    attendance_status: "upcoming",
    hours_worked: null,
    ...overrides,
  };
}

describe("bucketReportRows — weekly/monthly", () => {
  it("sums hours and counts on_time/late/missed within one week", () => {
    const rows: ReportRow[] = [
      row({
        event_id: "e1",
        start_at: "2026-01-05T15:00:00Z", // Monday
        attendance_status: "on_time",
        clock_in_at: "2026-01-05T15:00:00Z",
        clock_out_at: "2026-01-05T16:00:00Z",
        hours_worked: 1,
      }),
      row({
        event_id: "e2",
        start_at: "2026-01-07T15:00:00Z", // Wednesday, same ISO week
        attendance_status: "late",
        clock_in_at: "2026-01-07T15:20:00Z",
        clock_out_at: "2026-01-07T16:30:00Z",
        hours_worked: 1.1667,
      }),
      row({
        event_id: "e3",
        start_at: "2026-01-08T15:00:00Z", // Thursday, no session
        attendance_status: "missed",
      }),
    ];

    const summaries = bucketReportRows(rows, "weekly");
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary.periodStart).toBe("2026-01-05"); // Monday
    expect(summary.periodEnd).toBe("2026-01-11"); // Sunday
    expect(summary.onTimeCount).toBe(1);
    expect(summary.lateCount).toBe(1);
    expect(summary.missedCount).toBe(1);
    expect(summary.upcomingCount).toBe(0);
    expect(summary.scheduledCount).toBe(3);
    expect(summary.hoursWorked).toBeCloseTo(2.17, 2);
    // (on_time + late) / scheduled = 2/3 = 66.7%
    expect(summary.attendanceRatePct).toBeCloseTo(66.7, 1);
  });

  it("splits classes in different ISO weeks into separate buckets", () => {
    const rows: ReportRow[] = [
      row({ event_id: "e1", start_at: "2026-01-05T15:00:00Z", attendance_status: "on_time" }),
      row({ event_id: "e2", start_at: "2026-01-12T15:00:00Z", attendance_status: "on_time" }),
    ];
    const summaries = bucketReportRows(rows, "weekly");
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.periodStart).sort()).toEqual(["2026-01-05", "2026-01-12"]);
  });

  it("groups by calendar month regardless of week boundaries", () => {
    const rows: ReportRow[] = [
      row({ event_id: "e1", start_at: "2026-01-05T15:00:00Z", attendance_status: "on_time" }),
      row({ event_id: "e2", start_at: "2026-01-30T15:00:00Z", attendance_status: "late" }),
      row({ event_id: "e3", start_at: "2026-02-02T15:00:00Z", attendance_status: "missed" }),
    ];
    const summaries = bucketReportRows(rows, "monthly");
    expect(summaries).toHaveLength(2);
    const jan = summaries.find((s) => s.periodStart === "2026-01-01")!;
    expect(jan.periodEnd).toBe("2026-01-31");
    expect(jan.onTimeCount).toBe(1);
    expect(jan.lateCount).toBe(1);
    const feb = summaries.find((s) => s.periodStart === "2026-02-01")!;
    expect(feb.missedCount).toBe(1);
  });

  it("keeps separate teachers in separate buckets even for the same week", () => {
    const rows: ReportRow[] = [
      row({ event_id: "e1", teacher_id: "teacher-1", start_at: "2026-01-05T15:00:00Z", attendance_status: "on_time" }),
      row({ event_id: "e2", teacher_id: "teacher-2", start_at: "2026-01-05T15:00:00Z", attendance_status: "late" }),
    ];
    const summaries = bucketReportRows(rows, "weekly");
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries.map((s) => s.teacherId))).toEqual(new Set(["teacher-1", "teacher-2"]));
  });

  it("reports a null attendance rate when nothing has happened yet", () => {
    const rows: ReportRow[] = [row({ event_id: "e1", attendance_status: "upcoming" })];
    const summaries = bucketReportRows(rows, "weekly");
    expect(summaries[0].scheduledCount).toBe(0);
    expect(summaries[0].attendanceRatePct).toBeNull();
    expect(summaries[0].upcomingCount).toBe(1);
  });
});

describe("bucketReportRows — quarterly, anchored to school_years.start_date", () => {
  const schoolYear: SchoolYear = {
    id: "sy-1",
    name: "2025-2026",
    start_date: "2025-08-11",
    end_date: "2026-06-05",
    archived: false,
  };

  it("puts the first 63 days into quarter 1", () => {
    const rows: ReportRow[] = [
      row({ event_id: "e1", start_at: "2025-08-11T15:00:00Z", attendance_status: "on_time" }),
      // day index 62 (0-based) is still within quarter 1 (days 0..62)
      row({ event_id: "e2", start_at: "2025-10-12T15:00:00Z", attendance_status: "on_time" }),
    ];
    const summaries = bucketReportRows(rows, "quarterly", [schoolYear]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].periodLabel).toBe("Quarter 1");
    expect(summaries[0].periodStart).toBe("2025-08-11");
  });

  it("the 64th day (day index 63) starts quarter 2", () => {
    const rows: ReportRow[] = [
      row({ event_id: "e1", start_at: "2025-08-11T15:00:00Z", attendance_status: "on_time" }),
      row({ event_id: "e2", start_at: "2025-10-13T15:00:00Z", attendance_status: "on_time" }), // day index 63
    ];
    const summaries = bucketReportRows(rows, "quarterly", [schoolYear]);
    expect(summaries).toHaveLength(2);
    const labels = summaries.map((s) => s.periodLabel).sort();
    expect(labels).toEqual(["Quarter 1", "Quarter 2"]);
  });

  it("falls back to a 'No school year' bucket outside every known range", () => {
    const rows: ReportRow[] = [
      row({ event_id: "e1", start_at: "2027-01-01T15:00:00Z", attendance_status: "on_time" }),
    ];
    const summaries = bucketReportRows(rows, "quarterly", [schoolYear]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].periodLabel).toBe("No school year");
  });

  it("caps the final quarter at the school year's end_date", () => {
    // A short school year: 20 days total, well under one 63-day quarter.
    const shortYear: SchoolYear = {
      id: "sy-short",
      name: "short",
      start_date: "2025-08-11",
      end_date: "2025-08-30",
      archived: false,
    };
    const rows: ReportRow[] = [
      row({ event_id: "e1", start_at: "2025-08-11T15:00:00Z", attendance_status: "on_time" }),
    ];
    const summaries = bucketReportRows(rows, "quarterly", [shortYear]);
    expect(summaries[0].periodEnd).toBe("2025-08-30");
  });
});
