// The reason list is duplicated on purpose: SQL renders the note that lands in
// the spreadsheet (flag_reason_label in migration 0076), TypeScript draws the
// dropdown. Duplication is the right trade — building the label in SQL is what
// keeps the Flags tab's 93 historical rows and every new one in one shape —
// but it only holds if the two halves stay identical, which is what the first
// test here pins.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FLAG_REASONS,
  REASON_REQUIRING_NOTES,
  describeReasonGap,
  flagReasonLabel,
  isFlagReason,
} from "../src/lib/attendance/flag-reasons";

describe("the SQL twin", () => {
  const migration = readFileSync(
    "supabase/migrations/0076_flag_resolution_reasons.sql",
    "utf8",
  );

  // Pulled out of the case expression rather than hand-copied, so a label
  // edited on one side and not the other fails here instead of quietly
  // producing two spellings in the spreadsheet — the exact problem this whole
  // migration exists to end.
  const fromSql = [...migration.matchAll(/when '([a-z_]+)'\s+then '(.+?)'$/gm)].map(
    ([, value, label]) => ({ value, label }),
  );

  it("lists the same codes in the same order", () => {
    expect(fromSql.map((r) => r.value)).toEqual(FLAG_REASONS.map((r) => r.value));
  });

  it("uses character-identical labels", () => {
    expect(fromSql.map((r) => r.label)).toEqual(FLAG_REASONS.map((r) => r.label));
  });
});

describe("isFlagReason", () => {
  it("accepts every code on the list", () => {
    for (const reason of FLAG_REASONS) {
      expect(isFlagReason(reason.value)).toBe(true);
    }
  });

  it("rejects the free text managers used to type", () => {
    // Real notes from the first 120 flags. None of these may pass as a code.
    for (const junk of ["Forgot to do it", "Tech problem", "programs@ymu.org", "", "FORGOT"]) {
      expect(isFlagReason(junk)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isFlagReason(null)).toBe(false);
    expect(isFlagReason(undefined)).toBe(false);
    expect(isFlagReason(0)).toBe(false);
  });
});

describe("flagReasonLabel", () => {
  it("resolves the causes that dominated the first 120 flags", () => {
    expect(flagReasonLabel("forgot")).toBe("Forgot to clock in — was there on time");
    expect(flagReasonLabel("no_internet")).toBe("No internet at the school");
  });

  it("is undefined for an unknown code", () => {
    expect(flagReasonLabel("forgot_to_do_it")).toBeUndefined();
  });
});

describe("describeReasonGap", () => {
  it("passes a chosen reason with no notes", () => {
    expect(describeReasonGap("tech_problem", "")).toBeNull();
  });

  it("passes a chosen reason with notes", () => {
    expect(describeReasonGap("tech_problem", "app crashed on open")).toBeNull();
  });

  it("blocks an empty reason", () => {
    expect(describeReasonGap("", "")).toBe("Choose a reason.");
    expect(describeReasonGap("", "lots of detail here")).toBe("Choose a reason.");
  });

  it("blocks a reason that is not on the list", () => {
    expect(describeReasonGap("Forgot to do it", "")).toBe("Choose a reason from the list.");
  });

  // Without this rule "Other" becomes the path of least resistance and we are
  // back to uncountable notes, only now they all say Other.
  it("blocks Other with nothing written", () => {
    expect(describeReasonGap(REASON_REQUIRING_NOTES, "")).toContain("writing what happened");
    expect(describeReasonGap(REASON_REQUIRING_NOTES, "   ")).toContain("writing what happened");
  });

  it("passes Other once something is written", () => {
    expect(describeReasonGap("other", "school fire drill ran over")).toBeNull();
  });

  it("requires notes for Other and only for Other", () => {
    const needingNotes = FLAG_REASONS.filter((r) => describeReasonGap(r.value, "") !== null);
    expect(needingNotes.map((r) => r.value)).toEqual([REASON_REQUIRING_NOTES]);
  });
});
