import { describe, expect, it } from "vitest";
import {
  buildObjectivePayload,
  describeObjectiveGap,
  objectiveHeading,
  type ObjectiveSelection,
} from "../src/lib/feedback/objectives.ts";

function selection(overrides: Partial<ObjectiveSelection> = {}): ObjectiveSelection {
  return {
    isCustom: false,
    objectives: [],
    customProgramName: "",
    customNotes: "",
    ...overrides,
  };
}

// Spec §5. These two are the invariants the whole section is designed around,
// and both are enforced three times over — here, in the CHECK constraint added
// by migration 0032, and in submit_class_feedback(). This file is the layer
// that can actually be run.
describe("the two halves of Section 2 are mutually exclusive", () => {
  it("never sends objectives alongside a custom description", () => {
    // The state a stale render or a hand-crafted POST could produce: both
    // halves filled in at once.
    const payload = buildObjectivePayload(
      selection({
        isCustom: true,
        objectives: ["Rudiment #3", "Chromatic Scale"],
        customProgramName: "Steel Drum Club",
        customNotes: "Worked through the calypso ostinato.",
      }),
    );

    expect(payload.is_custom_program).toBe(true);
    expect(payload.objectives_worked).toEqual([]);
    expect(payload.custom_notes).toBe("Worked through the calypso ostinato.");
  });

  it("never sends a custom description alongside objectives", () => {
    const payload = buildObjectivePayload(
      selection({
        isCustom: false,
        objectives: ["Rudiment #3"],
        customProgramName: "Steel Drum Club",
        customNotes: "Left over from before they closed the escape hatch.",
      }),
    );

    expect(payload.is_custom_program).toBe(false);
    expect(payload.objectives_worked).toEqual(["Rudiment #3"]);
    expect(payload.custom_program_name).toBeNull();
    expect(payload.custom_notes).toBeNull();
  });

  it("holds for every combination of filled-in halves", () => {
    for (const isCustom of [true, false]) {
      for (const objectives of [[], ["Rudiment #3"]]) {
        for (const customNotes of ["", "Something else entirely."]) {
          const payload = buildObjectivePayload(
            selection({ isCustom, objectives, customProgramName: "Other", customNotes }),
          );
          const bothSides = payload.objectives_worked.length > 0 && payload.custom_notes !== null;
          expect(bothSides).toBe(false);
        }
      }
    }
  });
});

describe("switching program clears the previous answers", () => {
  it("drops ticked objectives the moment the escape hatch is open", () => {
    const ticked = selection({ objectives: ["Rudiment #3", "Cadence #1"] });
    // What the form's toggle produces — and what it would produce even if the
    // toggle forgot to reset state, which is the point.
    const opened = { ...ticked, isCustom: true, customProgramName: "X", customNotes: "Y" };
    expect(buildObjectivePayload(opened).objectives_worked).toEqual([]);
  });

  it("drops the hand-named program the moment the escape hatch is closed", () => {
    const named = selection({
      isCustom: true,
      customProgramName: "Steel Drum Club",
      customNotes: "Calypso ostinato.",
    });
    const closed = { ...named, isCustom: false, objectives: ["Rudiment #3"] };
    const payload = buildObjectivePayload(closed);
    expect(payload.custom_program_name).toBeNull();
    expect(payload.custom_notes).toBeNull();
  });
});

describe("normalisation", () => {
  it("de-duplicates and trims, so one objective cannot count twice", () => {
    const payload = buildObjectivePayload(
      selection({ objectives: ["Rudiment #3", " Rudiment #3 ", "", "  ", "Cadence #1"] }),
    );
    expect(payload.objectives_worked).toEqual(["Rudiment #3", "Cadence #1"]);
  });

  it("treats a whitespace-only custom program as unanswered", () => {
    const payload = buildObjectivePayload(
      selection({ isCustom: true, customProgramName: "   ", customNotes: "  " }),
    );
    expect(payload.custom_program_name).toBeNull();
    expect(payload.custom_notes).toBeNull();
  });
});

describe("describeObjectiveGap", () => {
  it("requires at least one objective when the program offers them", () => {
    expect(describeObjectiveGap(selection(), { offersObjectives: true })).toMatch(/at least one/i);
  });

  it("requires nothing when the program has no objectives loaded yet", () => {
    // Otherwise those teachers could not submit at all — the form has no
    // program picker for them to escape with.
    expect(describeObjectiveGap(selection(), { offersObjectives: false })).toBeNull();
  });

  it("passes once an objective is ticked", () => {
    const ticked = selection({ objectives: ["Rudiment #3"] });
    expect(describeObjectiveGap(ticked, { offersObjectives: true })).toBeNull();
  });

  it("requires both halves of the escape hatch", () => {
    const nameOnly = selection({ isCustom: true, customProgramName: "Steel Drum Club" });
    expect(describeObjectiveGap(nameOnly, { offersObjectives: true })).toMatch(/describe/i);

    const notesOnly = selection({ isCustom: true, customNotes: "Calypso ostinato." });
    expect(describeObjectiveGap(notesOnly, { offersObjectives: true })).toMatch(/name the program/i);

    const both = selection({
      isCustom: true,
      customProgramName: "Steel Drum Club",
      customNotes: "Calypso ostinato.",
    });
    expect(describeObjectiveGap(both, { offersObjectives: true })).toBeNull();
  });
});

describe("objectiveHeading", () => {
  it("names the detected program, because nothing else does", () => {
    expect(objectiveHeading("Drumline")).toBe("What was the objective of today's Drumline class?");
  });

  it("falls back cleanly when there is no program to name", () => {
    expect(objectiveHeading(null)).toBe("What was the objective of today's class?");
    expect(objectiveHeading("   ")).toBe("What was the objective of today's class?");
  });
});
