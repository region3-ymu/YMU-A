// Guessing a class's program from its Google Calendar title.
//
// The PRD assumes the shift already knows its program_id. It never has —
// calendar_events has no program column, and adding one would mean asking 111
// schools to re-tag every event they have already created.
//
// What they DO have is titles that are already the program names: "Drumline"
// x1685, "Music Production" x1265, "Beginning Band" x984, "Modern Band" x870.
// Measured against all 8,986 live events, matching on those resolves 99%.
// The remaining 1% is what the teacher's confirm step is for — this is a
// pre-fill, never a decision.
//
// Pure and dependency-free so the patterns can be regression-tested against
// real titles without a database.

export type ProgramRow = {
  id: string;
  name: string;
  category: "Ensemble" | "Production" | "NonFixed";
  match_patterns: string[];
  sort_order: number;
};

/**
 * The first program whose pattern appears in the title, in sort_order.
 *
 * Order is the whole design. "Marching Band" (10) has to be tried before
 * "Beginning Band" (30), and "Jazz Band" before anything generic, or a title
 * containing two program words resolves to whichever row happened to be
 * scanned first. Callers must pass programs already sorted, which is what the
 * query's `order by sort_order` guarantees.
 */
export function matchProgram(
  summary: string | null | undefined,
  programs: ProgramRow[],
): ProgramRow | null {
  if (!summary?.trim()) return null;
  const haystack = summary.toLowerCase();
  for (const program of programs) {
    for (const pattern of program.match_patterns) {
      const needle = pattern.trim().toLowerCase();
      if (needle && haystack.includes(needle)) return program;
    }
  }
  return null;
}

export const PILLAR_NONE = "__none__";

/**
 * Groups a program's chips under their pillar, preserving the order the query
 * returned them in. A Map because insertion order is guaranteed and the form
 * renders pillars in exactly that order.
 */
export function groupTopicsByPillar<T extends { pillar_category: string }>(
  topics: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const topic of topics) {
    const key = topic.pillar_category || PILLAR_NONE;
    const list = grouped.get(key);
    if (list) list.push(topic);
    else grouped.set(key, [topic]);
  }
  return grouped;
}

// PRD Section 1 — the engagement pulse (ITL Domain 4).
export const ENGAGEMENT_OPTIONS = [
  {
    value: "High",
    label: "High engagement & strong output",
    hint: "Active, created or performed music, showed ownership.",
  },
  {
    value: "Solid",
    label: "Solid / on target",
    hint: "Understood the task, participated well, met the objective.",
  },
  {
    value: "Low",
    label: "Low engagement / struggling",
    hint: "Passive, distracted, or struggled to participate.",
  },
] as const;

export type EngagementLevel = (typeof ENGAGEMENT_OPTIONS)[number]["value"];

// PRD Section 4 + Module B's category table. `category` is the Operational /
// Academic split the ticket records; it is a LABEL for filtering and reporting
// and never changes who the ticket is assigned to — YMU routes everything to
// the school's Regional Manager (2026-08-12).
export const ISSUE_SUBCATEGORIES = [
  { value: "attendance", label: "Attendance / missing students", category: "Operational" },
  { value: "behavior", label: "Student behavior & management", category: "Operational" },
  { value: "instruments", label: "Damaged / missing instruments", category: "Operational" },
  { value: "facilities", label: "Tech, connectivity or facilities", category: "Operational" },
  { value: "cancelled", label: "Class cancelled on site", category: "Operational" },
  { value: "repertoire", label: "Repertoire difficulty / sheet music", category: "Academic" },
  { value: "coaching", label: "Pedagogical support & coaching", category: "Academic" },
  { value: "technique", label: "Technique / literacy barriers", category: "Academic" },
] as const;

export const PRIORITY_OPTIONS = [
  { value: "Normal", label: "Normal", hint: "Handle within a few days." },
  { value: "High", label: "High", hint: "Needs attention today." },
  { value: "Urgent", label: "Urgent", hint: "Safety or a class that can't run." },
] as const;

/** PRD 2.2's hard floor before Submit unlocks. */
export const MIN_ISSUE_DESCRIPTION = 15;

export function issueCategoryFor(subcategory: string | null | undefined): "Operational" | "Academic" {
  const hit = ISSUE_SUBCATEGORIES.find((s) => s.value === subcategory);
  // Operational is the safe default: it routes to the Regional Manager, who
  // is the assignee for everything anyway, and mislabelling something as
  // Academic would quietly distort the PD planning aggregates.
  return hit?.category ?? "Operational";
}
