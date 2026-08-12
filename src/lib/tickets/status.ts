// The ticket lifecycle vocabulary, with no imports at all.
//
// Split out of queries.ts because the client controls need the labels while
// queries.ts reaches for lib/supabase/server, which pulls next/headers. A
// client component importing that chain fails the production build outright
// (it builds fine under tsc, so `npm run build` is what catches it). Same
// pure-module shape as lib/attendance/status.ts and feedback-due.ts.

export const TICKET_STATUSES = [
  "Open",
  "In_Progress",
  "Pending_Teacher",
  "Escalated",
  "On_Hold",
  "Resolved",
  "Closed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STATUS_LABELS: Record<TicketStatus, string> = {
  Open: "Open",
  In_Progress: "In progress",
  Pending_Teacher: "Waiting on teacher",
  Escalated: "Escalated",
  On_Hold: "On hold",
  Resolved: "Resolved",
  Closed: "Closed",
};

// Statuses that still need someone to act. Drives the default inbox filter —
// a manager opening /tickets wants their queue, not an archive.
export const OPEN_STATUSES: TicketStatus[] = [
  "Open",
  "In_Progress",
  "Pending_Teacher",
  "Escalated",
  "On_Hold",
];

// PRD 4.5 — required before a ticket can be Resolved, because it is the only
// input to the PD-planning aggregate and nobody remembers it a week later.
export const ROOT_CAUSES = [
  { value: "Curriculum_Pedagogy", label: "Curriculum & pedagogy" },
  { value: "Technology_Software", label: "Technology & software" },
  { value: "Facilities_Logistics", label: "Facilities & logistics" },
  { value: "Classroom_Mgmt_Safety", label: "Classroom management & safety" },
  { value: "Payroll_Administrative", label: "Payroll & administrative" },
] as const;

export type SlaState = "on_track" | "warning" | "breached" | "met" | "missed";

export const SLA_LABELS: Record<SlaState, string> = {
  on_track: "On track",
  warning: "Due soon",
  breached: "Overdue",
  met: "Met SLA",
  missed: "Missed SLA",
};

// PRD 4.3's targets, restated for display only. The breach decision itself is
// made in SQL (ticket_ttr_target_hours) so an agent and an Admin can never see
// different verdicts on the same ticket.
export const TTR_TARGET_HOURS: Record<string, number> = {
  Urgent: 4,
  High: 24,
  Normal: 72,
};

/**
 * Minutes as something a person reads at a glance: "3h", "2d 4h", "45m".
 * Coarse on purpose — a support queue is not a stopwatch, and false precision
 * invites arguments about a number nobody should be optimising to the minute.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = Math.round(minutes % 60);
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}
