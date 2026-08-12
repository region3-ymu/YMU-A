// Section 2 of the daily feedback form: which objectives today's class worked
// on, or — when the program was detected wrongly — what it actually was.
//
// Pure and dependency-free, because the invariants below are the whole point
// of the section and deserve to be tested without a browser or a database.
//
// The two halves are mutually exclusive by construction, not by discipline.
// The teacher does not choose the program (YMU overrode the spec's dropdown —
// it is read from the calendar title), so "Other" is the only escape hatch a
// mis-detected class has, and a submission that carried both a tick-list and a
// hand-written program would mean the form had let someone describe one
// program while ticking another's objectives.

/** What the form's controls currently hold. */
export type ObjectiveSelection = {
  /** The teacher opened the "not this one?" escape hatch. */
  isCustom: boolean;
  objectives: string[];
  customProgramName: string;
  customNotes: string;
};

/** What actually goes to submit_class_feedback(). */
export type ObjectivePayload = {
  objectives_worked: string[];
  is_custom_program: boolean;
  custom_program_name: string | null;
  custom_notes: string | null;
};

export const EMPTY_OBJECTIVE_SELECTION: ObjectiveSelection = {
  isCustom: false,
  objectives: [],
  customProgramName: "",
  customNotes: "",
};

function clean(value: string) {
  return value.trim();
}

/**
 * Normalises a selection into the payload, dropping whichever half the chosen
 * path does not own.
 *
 * This is the enforcement point for spec §5, not a convenience: the form
 * already clears the other half whenever the escape hatch is toggled, but that
 * is a habit of the UI, and a stale value surviving one render — or a
 * hand-crafted POST — must still be unable to produce a row carrying both.
 * The same rule is a CHECK constraint in migration 0032, so all three layers
 * agree.
 */
export function buildObjectivePayload(selection: ObjectiveSelection): ObjectivePayload {
  if (selection.isCustom) {
    return {
      objectives_worked: [],
      is_custom_program: true,
      custom_program_name: clean(selection.customProgramName) || null,
      custom_notes: clean(selection.customNotes) || null,
    };
  }
  // De-duplicated and blank-stripped here rather than only in SQL, so what the
  // teacher is told they submitted matches what lands in the aggregates.
  const seen = new Set<string>();
  for (const raw of selection.objectives) {
    const value = clean(raw);
    if (value) seen.add(value);
  }
  return {
    objectives_worked: [...seen],
    is_custom_program: false,
    custom_program_name: null,
    custom_notes: null,
  };
}

/**
 * Why Submit is still disabled, or null when the section is complete.
 *
 * `offersObjectives` is false when the detected program has no objectives
 * loaded yet. Requiring a tick from a list that is empty would lock those
 * teachers out of submitting at all, so the escape hatch carries them instead.
 */
export function describeObjectiveGap(
  selection: ObjectiveSelection,
  { offersObjectives }: { offersObjectives: boolean },
): string | null {
  const payload = buildObjectivePayload(selection);
  if (payload.is_custom_program) {
    if (!payload.custom_program_name) return "Please name the program you actually taught.";
    if (!payload.custom_notes) return "Please describe what you worked on.";
    return null;
  }
  if (offersObjectives && payload.objectives_worked.length === 0) {
    return "Please choose at least one objective you worked on today.";
  }
  return null;
}

/**
 * The section's heading, named after the class the teacher just taught.
 *
 * The program is shown, never chosen, so the heading is where the teacher
 * finds out which one the calendar title resolved to — it has to say the name
 * out loud or a wrong detection is invisible until the data is wrong.
 */
export function objectiveHeading(programName: string | null | undefined): string {
  const name = programName?.trim();
  return name
    ? `What was the objective of today's ${name} class?`
    : "What was the objective of today's class?";
}
