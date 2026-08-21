/**
 * Why a teacher's clock-in did not happen on time.
 *
 * Twin of public.flag_reason_label() in migration 0076. The labels have to be
 * character-identical: SQL builds the resolution note (so the wording is the
 * same whichever entry point a manager used, and so the Flags tab keeps the
 * shape its 93 historical rows already have), while this list draws the
 * dropdown. tests/flag-reasons.test.ts guards the pairing.
 *
 * Seven, in YMU's own order (2026-08-21). It started as eleven, drawn from the
 * causes in the first 120 flags, and four came back out for reasons worth
 * keeping:
 *
 *   arrived_late       — redundant. The attendance form already asks on-time
 *                        or late, and minutes_late is now exported on the
 *                        Flags tab. Lateness is a fact in the data, not a
 *                        reason somebody types.
 *   back_to_back       — solved rather than recorded. The six carryover rules
 *                        in 0077 mean the second class of a run no longer
 *                        raises a flag at all.
 *   substitute_covered — lives on the OUTCOME list instead (0080), where it
 *                        links to a real substitution. Asking the same
 *                        question twice, once as prose and once as a link, is
 *                        how you get two answers. The reason here stays
 *                        `teacher_absent`, which is what was true.
 *   flag_in_error      — no purpose. A junk or test flag is `other` with a
 *                        note, and a category for "ignore this" invites use as
 *                        the quickest way out of the screen.
 */
export const FLAG_REASONS = [
  { value: "forgot", label: "Forgot to clock in — was there on time" },
  { value: "tech_problem", label: "App or phone problem" },
  { value: "calendar_time_wrong", label: "Calendar time is wrong — class starts later" },
  { value: "no_internet", label: "No internet at the school" },
  { value: "teacher_absent", label: "Teacher was absent" },
  { value: "class_not_held", label: "Class did not happen" },
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
