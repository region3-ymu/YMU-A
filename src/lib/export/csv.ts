// Hand-rolled CSV encoding — no dependency, matching this project's existing
// minimalism precedent (e.g. the hand-written PNG encoder in Phase 0).
// RFC 4180 quoting: wrap a field in double quotes if it contains a comma,
// quote, or newline, and double up any embedded quotes.

import type { PeriodSummary } from "@/lib/reports/types";

export function csvField(value: string | number): string {
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
    // Ahead of hours, and taught rather than scheduled: YMU reads the two
    // together and a missed class is not one the teacher gave.
    "Classes taught",
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
        row.taughtCount,
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

export type RelayFeedbackRow = {
  teacherName: string;
  schoolName: string;
  className: string;
  clockInAt: string;
  relayBlock: string | null;
  programArea: string | null;
  objective: string | null;
  achievedObjective: string | null;
  objectiveReflection: string | null;
  engagementScale: number | null;
  challenges: string[] | null;
  pivots: string | null;
  submittedAt: string | null;
};

// "Save it in a spreadsheet" for this week's native PD relay feedback
// (migration 0022) — a plain CSV export opens directly in Sheets/Excel, no
// live Google Sheets sync needed for a one-week form.
export function relayFeedbackRowsToCsv(rows: RelayFeedbackRow[]): string {
  const header = [
    "Teacher",
    "School",
    "Class",
    "Clocked in at",
    "Relay Block",
    "Program Area",
    "Objective",
    "Achieved Objective",
    "Objective Reflection",
    "Engagement (1-5)",
    "Challenges",
    "Reflection & Pivots",
    "Submitted at",
  ];

  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.teacherName,
        row.schoolName,
        row.className,
        row.clockInAt,
        row.relayBlock ?? "",
        row.programArea ?? "",
        row.objective ?? "",
        row.achievedObjective ?? "",
        row.objectiveReflection ?? "",
        row.engagementScale ?? "",
        (row.challenges ?? []).join("; "),
        row.pivots ?? "",
        row.submittedAt ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
