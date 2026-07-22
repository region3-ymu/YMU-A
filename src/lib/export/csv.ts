// Hand-rolled CSV encoding — no dependency, matching this project's existing
// minimalism precedent (e.g. the hand-written PNG encoder in Phase 0).
// RFC 4180 quoting: wrap a field in double quotes if it contains a comma,
// quote, or newline, and double up any embedded quotes.

import type { PeriodSummary } from "@/lib/reports/types";

function csvField(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function periodSummariesToCsv(
  rows: PeriodSummary[],
  teacherNameById: Map<string, string>,
): string {
  const header = [
    "Teacher",
    "Period start",
    "Period end",
    "Hours worked",
    "On time",
    "Late",
    "Missed",
    "Upcoming",
    "Attendance rate %",
  ];

  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        teacherNameById.get(row.teacherId) ?? row.teacherId,
        row.periodStart,
        row.periodEnd,
        row.hoursWorked,
        row.onTimeCount,
        row.lateCount,
        row.missedCount,
        row.upcomingCount,
        row.attendanceRatePct ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  // CRLF per RFC 4180; also what every spreadsheet app expects.
  return lines.join("\r\n") + "\r\n";
}
