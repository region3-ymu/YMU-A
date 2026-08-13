// The shape of the YMU feedback spreadsheet.
//
// THIS ORDER IS LOAD-BEARING. Rows are appended to a sheet that already holds
// data, so column N in a row written last month must still mean what it meant
// then. A new field goes at the END; an existing position is never re-used for
// a different meaning, and one is never removed. `focus_pillar` is the worked
// example: the pillar it recorded was retired with the pillar-era form in
// migration 0032, and it still occupies position 14 returning nothing, because
// deleting it would slide five columns of history sideways.
//
// Shared by both writers — the cron route (src/app/api/sheet-sync) and the
// by-hand script (scripts/sync-feedback-sheet.ts). They previously kept
// identical private copies, which is exactly the kind of pair that drifts on
// the first schema change and corrupts the sheet silently rather than loudly.
//
// COLUMNS are keys of feedback_for_sheet()'s result; HEADER is the human row.
// They are index-for-index parallel, which assertSheetColumnsMatchHeader keeps
// true.

export const COLUMNS = [
  "id", "submitted_at", "class_date", "class_time",
  "teacher_name", "teacher_email", "teacher_phone",
  "school_name", "region", "regional_manager",
  "class_title", "program",
  "engagement", "focus_pillar", "objectives", "open_notes", "quarter_goals_on_track",
  "reported_issue", "issue_category", "issue_type", "issue_priority", "issue_description",
  "ticket_number", "ticket_status", "ticket_owner", "root_cause",
  "clock_in_status", "clock_in_at", "session_origin",
  // Added by 0032, and therefore last: the "not this one?" escape hatch, for
  // the class whose program the calendar title got wrong.
  "custom_program", "custom_notes",
] as const;

// SEVERAL OF THESE SAY "at submission", AND THAT IS NOT DECORATION.
//
// This export is append-only with a one-shot watermark: a row is written once
// and never revisited. But it denormalises columns that keep changing — the
// ticket's status, owner and root cause, and the session's clock-in details.
// Because submit_class_feedback() creates the feedback row and its ticket in
// the same transaction and the cron runs two minutes later, the sheet captures
// every ticket at BIRTH: status Open, root cause blank. It stays that way
// forever, however the ticket is later resolved.
//
// Anyone charting resolution rates off these columns would get a number that
// is not merely stale but structurally wrong. The positions cannot be reused
// or removed — months of rows sit under them — so the labels carry the
// warning, and the `Tickets` tab (see sheet-tabs.ts) is the live answer.
export const HEADER: string[] = [
  "Feedback ID", "Submitted at", "Class date", "Class time",
  "Teacher", "Teacher email", "Teacher phone",
  "School", "Region", "Regional manager",
  "Class title", "Program",
  "Engagement", "Focus pillar (retired)", "Objectives worked", "Open notes",
  "Quarter goals on track",
  "Reported an issue", "Issue category (at submission)", "Issue type (at submission)",
  "Urgency (at submission)", "What the teacher wrote",
  "Ticket #", "Ticket status (at submission — see Tickets tab)",
  "Ticket owner (at submission)", "Root cause (at submission — see Tickets tab)",
  "Clock-in status (at submission)", "Clocked in at (at submission)",
  "Clock-in origin",
  "Other program (teacher-named)", "Other program — what they worked on",
];

/** Turns one RPC row into the sheet row, in COLUMNS order. */
export function toSheetRow(row: Record<string, unknown>): (string | number | boolean)[] {
  return COLUMNS.map((key) => {
    const value = row[key];
    if (value == null) return "";
    return typeof value === "number" || typeof value === "boolean" ? value : String(value);
  });
}

if (COLUMNS.length !== HEADER.length) {
  // Loud at import time rather than quiet at append time: a mismatch here
  // writes data under the wrong heading for every row from then on.
  throw new Error(
    `Feedback sheet columns and header are out of step (${COLUMNS.length} vs ${HEADER.length}).`,
  );
}
