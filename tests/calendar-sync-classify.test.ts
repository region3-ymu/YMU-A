// Unit tests for classifyDiscoveredCalendar(), the pure decision function
// syncAllCalendars() uses to route a discovered calendar to auto-match,
// already-pinned, or the manager review queue. Pure and synchronous, so it's
// tested here against synthetic candidates with no Google/Supabase
// involved -- this is also where CALENDAR_MATCH_THRESHOLD/AMBIGUITY_MARGIN
// should be re-validated once the real planned calendar-summary strings are
// known, before enabling the sync against real calendars.

import { describe, expect, it } from "vitest";
import {
  classifyDiscoveredCalendar,
  schoolLevel,
  type CalendarMatchCandidate,
} from "../supabase/functions/calendar-sync/sync.ts";

function candidate(school_id: string, school_name: string, score: number): CalendarMatchCandidate {
  return { school_id, school_name, score };
}

describe("classifyDiscoveredCalendar", () => {
  it("skips a calendar that is already pinned to a school", () => {
    const decision = classifyDiscoveredCalendar("cal-1", new Set(["cal-1"]), [candidate("s1", "School One", 0.9)]);
    expect(decision).toEqual({ action: "already_pinned" });
  });

  it("flags a calendar with zero candidates as unmatched", () => {
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), []);
    expect(decision).toEqual({ action: "flag_issue", reason: "no_matching_school", candidates: [] });
  });

  it("flags a calendar whose best candidate is below the threshold as unmatched", () => {
    const candidates = [candidate("s1", "School One", 0.2)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "flag_issue", reason: "no_matching_school", candidates });
  });

  it("flags an ambiguous match when the top two candidates are within the margin", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.7), candidate("s2", "Roosevelt Middle", 0.66)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "flag_issue", reason: "ambiguous_match", candidates });
  });

  it("auto-matches a clear top candidate above both the threshold and the ambiguity margin", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.9), candidate("s2", "Roosevelt Middle", 0.4)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.9 });
  });

  it("auto-matches a lone candidate with no second candidate to be ambiguous against", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.6)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.6 });
  });

  it("flags a calendar whose top school is already linked to a different calendar (two calendars sharing a name)", () => {
    // e.g. two real Google Calendars both literally named "South Dade Senior
    // High" -- the second one must never silently steal the first's pin.
    const candidates = [candidate("s1", "South Dade Senior High", 1)];
    const decision = classifyDiscoveredCalendar("cal-2", new Set(["cal-1"]), candidates, new Set(["s1"]));
    expect(decision).toEqual({ action: "flag_issue", reason: "school_already_linked", candidates });
  });

  it("still auto-matches when the top school is not in pinnedSchoolIds", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.9)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates, new Set(["s2"]));
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.9 });
  });
});

describe("schoolLevel", () => {
  it("reads the four Miami-Dade school levels", () => {
    expect(schoolLevel("Homestead Senior High")).toBe("HS");
    expect(schoolLevel("Miami Central High School")).toBe("HS");
    expect(schoolLevel("Miami Norland Senior HS")).toBe("HS");
    expect(schoolLevel("Homestead Middle School")).toBe("MS");
    expect(schoolLevel("John F. Kennedy MS")).toBe("MS");
    expect(schoolLevel("Arcola Lake Elementary School")).toBe("ES");
    expect(schoolLevel("Oak Grove ES")).toBe("ES");
    expect(schoolLevel("Leisure City K-8")).toBe("K8");
    expect(schoolLevel("North County K-8 Center")).toBe("K8");
  });

  // K-8 is checked first on purpose: "K-8 Center" contains neither "high" nor
  // "middle", but "Bowman Ashe/Doolin K-8 Academy" and friends must not fall
  // through to a later, looser pattern.
  it("prefers K-8 over any other token in the same name", () => {
    expect(schoolLevel("Henry E. S. Reeves K-8 Center")).toBe("K8");
    expect(schoolLevel("Carrie P. Meek/Westview K-8")).toBe("K8");
  });

  it("returns null for a name that declares no level", () => {
    expect(schoolLevel("Mast Academy")).toBeNull();
    expect(schoolLevel("Beacon College Prep")).toBeNull();
    expect(schoolLevel("SEED School of Miami")).toBeNull();
    expect(schoolLevel("Robert Renick Educational Center")).toBeNull();
    expect(schoolLevel(null)).toBeNull();
    expect(schoolLevel("")).toBeNull();
  });
});

describe("classifyDiscoveredCalendar — school level guard", () => {
  // The exact production failure of 2026-08-12. pg_trgm scored these two
  // unrelated schools at 0.67 — over the 0.5 threshold, with no runner-up
  // close enough to trip the ambiguity margin — and the sync pinned Hialeah
  // Senior High to Homestead Senior High's calendar. Both are high schools, so
  // the level guard does NOT catch this one; it is here to pin down what the
  // guard is and isn't for.
  it("does not flag two schools that share a level, even when badly matched", () => {
    const candidates = [candidate("s1", "Hialeah Senior High", 0.667)];
    const decision = classifyDiscoveredCalendar(
      "cal-homestead", new Set(), candidates, new Set(), "Homestead Senior High",
    );
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.667 });
  });

  // The family-name collision the guard exists for: Miami-Dade runs a senior
  // high and a middle school under the same place name at most sites, and
  // their trigram similarity is high enough to auto-match.
  it("flags a high-school calendar matched to a middle school of the same name", () => {
    const candidates = [candidate("s1", "Homestead Middle School", 0.82)];
    const decision = classifyDiscoveredCalendar(
      "cal-1", new Set(), candidates, new Set(), "Homestead Senior High",
    );
    expect(decision).toEqual({ action: "flag_issue", reason: "level_mismatch", candidates });
  });

  it("flags an elementary calendar matched to a K-8 of the same name", () => {
    const candidates = [candidate("s1", "Edison Park K-8 Center", 0.78)];
    const decision = classifyDiscoveredCalendar(
      "cal-1", new Set(), candidates, new Set(), "Edison Park Elementary",
    );
    expect(decision).toEqual({ action: "flag_issue", reason: "level_mismatch", candidates });
  });

  it("auto-matches when both names agree on the level", () => {
    const candidates = [candidate("s1", "Norland Middle School", 1)];
    const decision = classifyDiscoveredCalendar(
      "cal-1", new Set(), candidates, new Set(), "Norland Middle School",
    );
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 1 });
  });

  // Silence on either side is common and must stay harmless, otherwise every
  // "Mast Academy"-style name lands in the review queue for nothing.
  it("auto-matches when only one side declares a level", () => {
    const candidates = [candidate("s1", "Mast Academy", 0.9)];
    expect(
      classifyDiscoveredCalendar("cal-1", new Set(), candidates, new Set(), "Mast Academy High"),
    ).toEqual({ action: "auto_match", schoolId: "s1", score: 0.9 });
  });

  // Callers that predate the guard pass no summary at all; they must keep the
  // old behaviour rather than start flagging everything.
  it("auto-matches when no calendar summary is supplied", () => {
    const candidates = [candidate("s1", "Homestead Middle School", 0.82)];
    expect(classifyDiscoveredCalendar("cal-1", new Set(), candidates)).toEqual({
      action: "auto_match", schoolId: "s1", score: 0.82,
    });
  });
});
