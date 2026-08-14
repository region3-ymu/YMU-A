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

// YMU runs exactly six programs (confirmed 2026-08-12). Guitar and jazz with a
// rhythm section are Modern Band; every other ensemble — Rock, Jazz, Fusion,
// Orchestra — is After School, which doubles as the catch-all when a title
// matches nothing at all.
export const FALLBACK_PROGRAM_NAME = "After School";

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

/**
 * The program for a class, always. The teacher is no longer asked (YMU
 * 2026-08-12): asking cost a tap on every single class to confirm something
 * the title already said 99% of the time.
 *
 * Falling back to After School rather than returning null is what makes that
 * possible — with no picker there is no way for a teacher to resolve a null,
 * so an unmatched title has to land somewhere, and After School is the
 * catch-all YMU nominated.
 */
export function resolveProgram(
  summary: string | null | undefined,
  programs: ProgramRow[],
): ProgramRow | null {
  return (
    matchProgram(summary, programs)
    ?? programs.find((p) => p.name === FALLBACK_PROGRAM_NAME)
    ?? null
  );
}

// Nothing groups by pillar_category any more. The approved spec replaces the
// PRD's pillars with one flat objective list per program, and the loaded data
// no longer agrees on pillar names anyway — Music Production's 30 objectives
// sit under a single pillar called "Objectives" while the other six still
// carry the four PRD names. Reading the column would have made that
// inconsistency visible to teachers for no benefit; ignoring it makes the
// inconsistency inert. The column stays on program_topics as a loading
// artefact.

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
  // Added 2026-08-13 (Juan Pelaez's cancellation spec). A 4th option here
  // rather than a new question or screen, so the normal path costs no extra
  // taps: the cancellation route only appears once a teacher reaches for it.
  // Selecting it hides Sections 2 and 3 and files an Operational ticket —
  // see submit_class_feedback() and CANCELLED_ENGAGEMENT below.
  {
    value: "Canceled",
    label: "Class canceled — no session held",
    hint: "The scheduled class did not take place today.",
  },
] as const;

export type EngagementLevel = (typeof ENGAGEMENT_OPTIONS)[number]["value"];

/**
 * The engagement value that means "this class did not happen".
 *
 * Named rather than spelled out at each site: the form, the server action, the
 * teacher's list and the ticket detail all branch on it, and a typo in any one
 * of them fails silently as "a normal class".
 */
export const CANCELLED_ENGAGEMENT = "Canceled";

/**
 * Short labels for reading a submission back. Kept beside the options so the
 * form and the two read-only views can never drift — they used to carry their
 * own literal maps, and adding a 4th level meant remembering all three.
 */
export const ENGAGEMENT_LABELS: Record<string, string> = {
  High: "High engagement",
  Solid: "Solid / on target",
  Low: "Low engagement",
  Canceled: "Class canceled",
};

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
