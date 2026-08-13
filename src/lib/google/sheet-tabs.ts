// Every tab of the YMU spreadsheet except Feedback, in one table.
//
// YMU's Academic Manager asked for all the app's data in one spreadsheet so he
// can build dashboards without asking us for a code change. The way to honour
// that is to export FACTS, not dashboards: one row per real thing, plus small
// reference lists to join against, so a question nobody has thought of yet is
// a pivot table rather than a ticket for us.
//
// ── Why these are snapshots and Feedback is not ───────────────────────────
//
// Feedback rows never change after they are written (verified: sheet_synced_at
// is the only mutable column on the table), so it is mirrored append-only with
// a watermark, and that stays exactly as it is.
//
// Everything here DOES change. A ticket's status, owner and root cause move
// for days; its resolved_at is not even monotonic, because reopening nulls it.
// A session gets its clock-out hours later, and a manager can correct the
// clock-in time weeks later. Appending those produces either duplicates or a
// row frozen at its least useful moment — which is exactly what happened to
// the ticket columns on the Feedback tab, and why they are labelled
// "(at submission)" there and authoritative only here.
//
// Incremental sync was considered and rejected: it needs
// `updated_at > sheet_synced_at`, and tickets.updated_at has no trigger — it
// is maintained by RPC convention, so one direct UPDATE would leave a row that
// never syncs again. A snapshot cannot drift, at the cost of rewriting a tab
// that mostly did not change. At YMU's volume that trade is free.
//
// ── Adding a tab ─────────────────────────────────────────────────────────
//
// Write a `*_for_sheet()` function in SQL that resolves its own names and
// labels, grant it to service_role, and add an entry below. Nothing else.

export type SheetTab = {
  /** Tab name in the spreadsheet. Changing it strands the old tab's data. */
  name: string;
  /** A service_role-only SQL function returning the rows. */
  rpc: string;
  args?: Record<string, unknown>;
  /** Keys of the RPC result, in the order they should appear. */
  columns: readonly string[];
  /** Human labels, index-for-index with `columns`. */
  header: readonly string[];
  /** One line written into the app's own docs, not the sheet. */
  note: string;
};

export const SHEET_TABS: SheetTab[] = [
  {
    name: "Attendance",
    rpc: "attendance_for_sheet",
    // The current school year. Without bounds this would also mirror two
    // previous years of history nobody is analysing, tripling the tab for no
    // gain.
    args: { p_from: "2026-08-01T00:00:00-04:00", p_to: "2027-07-01T00:00:00-04:00" },
    columns: [
      "class_date", "class_time", "class_title", "program",
      "teacher_name", "teacher_email", "school_name", "region", "regional_manager",
      "attendance_status", "clock_in_at", "clock_in_minutes_late",
      "clock_out_at", "clock_out_source", "hours_worked",
      "clock_in_origin", "distance_m", "feedback_submitted",
      "event_id", "session_id",
    ],
    header: [
      "Class date", "Class time", "Class title", "Program",
      "Teacher", "Teacher email", "School", "Region", "Regional manager",
      "Status", "Clocked in at", "Minutes late",
      "Clocked out at", "Clock-out by", "Hours",
      "Clock-in origin", "Metres from school", "Feedback submitted",
      "Event ID", "Session ID",
    ],
    note: "One row per teacher per scheduled class. Late clock-ins, absences and hours all come from here.",
  },
  {
    name: "Tickets",
    rpc: "tickets_for_sheet",
    columns: [
      "ticket_number", "created_date", "created_time", "status",
      "category", "issue_type", "priority",
      "teacher_name", "school_name", "region", "assigned_to",
      "description", "root_cause",
      "sla_state", "target_hours", "first_response_minutes",
      "awaiting_response_minutes", "effective_resolution_minutes",
      "paused_minutes", "reopen_count", "unanswered_overdue",
      "resolved_at", "closed_at",
    ],
    header: [
      "Ticket #", "Raised date", "Raised time", "Status",
      "Category", "Issue type", "Priority",
      "Teacher", "School", "Region", "Assigned to",
      "What the teacher wrote", "Root cause",
      "SLA", "Target (hours)", "First response (min)",
      "Waiting for reply (min)", "Resolution time (min)",
      "Paused (min)", "Times reopened", "Unanswered 24h+",
      "Resolved at", "Closed at",
    ],
    note: "THE source of truth for ticket state. The Feedback tab's ticket columns are frozen at submission.",
  },
  {
    name: "Flags",
    rpc: "flags_for_sheet",
    columns: [
      "raised_date", "raised_time", "flag_type", "teacher_name",
      "school_name", "region", "class_title", "class_date",
      "status", "resolved_at", "resolved_by", "resolution_notes", "distance_m",
    ],
    header: [
      "Raised date", "Raised time", "Type", "Teacher",
      "School", "Region", "Class", "Class date",
      "Status", "Resolved at", "Resolved by", "Resolution notes", "Metres from school",
    ],
    note: "GPS, late clock-in and overdue-feedback escalations, open and resolved.",
  },
  {
    name: "Schools",
    rpc: "schools_for_sheet",
    columns: [
      "school_name", "region", "address", "has_coordinates",
      "geofence_radius_m", "has_calendar", "classes_this_year",
    ],
    header: [
      "School", "Region", "Address", "Can be clocked into",
      "Geofence (m)", "Calendar connected", "Classes this year",
    ],
    note: "Reference list. Join any fact tab to this to group by region.",
  },
  {
    name: "Teachers",
    rpc: "teachers_for_sheet",
    columns: [
      "teacher_name", "email", "phone", "regions",
      "schools", "classes_this_year", "status",
    ],
    header: [
      "Teacher", "Email", "Phone", "Regions",
      "Schools (last 30 days)", "Classes (last 30 days)", "Status",
    ],
    note: "Reference list. Regions are derived from where they are scheduled, not from their profile.",
  },
  {
    name: "Programs",
    rpc: "programs_for_sheet",
    columns: ["program", "category", "objective", "active"],
    header: ["Program", "Category", "Objective", "Active"],
    note: "The objective lists teachers pick from on the feedback form.",
  },
  {
    name: "Ticket insights",
    rpc: "ticket_insights_for_sheet",
    columns: [
      "root_cause", "category", "tickets",
      "avg_resolution_hours", "schools_affected", "teachers_affected",
    ],
    header: [
      "Root cause", "Category", "Tickets",
      "Avg resolution (hours)", "Schools affected", "Teachers affected",
    ],
    note: "Pre-aggregated from resolved tickets. Everything here is derivable from the Tickets tab.",
  },
];

/** Turns one RPC row into a sheet row, in the tab's column order. */
export function toTabRow(
  tab: SheetTab,
  row: Record<string, unknown>,
): (string | number | boolean)[] {
  return tab.columns.map((key) => {
    const value = row[key];
    if (value == null) return "";
    return typeof value === "number" || typeof value === "boolean" ? value : String(value);
  });
}

for (const tab of SHEET_TABS) {
  if (tab.columns.length !== tab.header.length) {
    // Loud at import rather than quiet at write time: a mismatch here puts
    // every value under the wrong heading, which reads as plausible data.
    throw new Error(
      `Sheet tab "${tab.name}" has ${tab.columns.length} columns and ${tab.header.length} headers.`,
    );
  }
}
