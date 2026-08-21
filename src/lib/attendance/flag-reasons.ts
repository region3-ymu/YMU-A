/**
 * Why a teacher's clock-in did not happen on time.
 *
 * Twin of public.flag_reason_label() in migration 0076. The labels have to be
 * character-identical: SQL builds the resolution note (so the wording is the
 * same whichever entry point a manager used, and so the Flags tab keeps the
 * shape its 93 historical rows already have), while this list draws the
 * dropdown. tests/flag-reasons.test.ts guards the pairing.
 *
 * Ordered by how often the cause actually showed up in the first 120 flags,
 * not alphabetically — the manager resolving twenty of these in a sitting
 * should find the common answer without reading the whole list. Counts from
 * the 49 notes that had prose: forgot 19, tech 10, calendar 5, internet 3,
 * substitute 3, traffic 2, back-to-back 2.
 *
 * `teacher_absent`, `class_not_held` and `flag_in_error` had no canonical
 * spelling to count — managers were writing them as prose ("Substitute
 * Assigned", "PRUEBA - diagnostico") or not resolving the flag at all.
 */
export const FLAG_REASONS = [
  { value: "forgot", label: "Forgot to clock in — was there on time" },
  { value: "tech_problem", label: "App or phone problem" },
  { value: "no_internet", label: "No internet at the school" },
  { value: "calendar_time_wrong", label: "Calendar time is wrong — class starts later" },
  { value: "back_to_back", label: "Back-to-back class — clocked in for the first one" },
  { value: "arrived_late", label: "Arrived late (traffic / travel)" },
  { value: "substitute_covered", label: "A substitute covered the class" },
  { value: "teacher_absent", label: "Teacher was absent" },
  { value: "class_not_held", label: "Class did not happen" },
  { value: "flag_in_error", label: "Flag raised in error / test data" },
  { value: "other", label: "Other" },
] as const;

export type FlagReason = (typeof FLAG_REASONS)[number]["value"];

/** The only reason that makes the notes field mandatory. */
export const REASON_REQUIRING_NOTES: FlagReason = "other";

export function isFlagReason(value: unknown): value is FlagReason {
  return FLAG_REASONS.some((reason) => reason.value === value);
}

export function flagReasonLabel(value: string): string | undefined {
  return FLAG_REASONS.find((reason) => reason.value === value)?.label;
}

/**
 * The client-side half of flag_resolution_note()'s validation, so the manager
 * hears about a missing note before the round trip. SQL raises on the same two
 * conditions regardless — this is the courtesy, not the rule.
 *
 * Returns null when the form is good to submit.
 */
export function describeReasonGap(reason: string, notes: string): string | null {
  if (!reason) return "Choose a reason.";
  if (!isFlagReason(reason)) return "Choose a reason from the list.";
  if (reason === REASON_REQUIRING_NOTES && notes.trim() === "") {
    return "Choosing “Other” means writing what happened.";
  }
  return null;
}
