// Regression tests for deriving a class's program from its calendar title.
//
// The cases here are real titles taken from the 8,986 live calendar_events
// rows, not invented ones. The whole approach rests on those titles already
// being program names, so the test data has to be the actual data.

import { describe, expect, it } from "vitest";
import {
  groupTopicsByPillar,
  issueCategoryFor,
  matchProgram,
  resolveProgram,
  type ProgramRow,
} from "../src/lib/feedback/program-match";

// Mirrors the seed in migration 0030, in sort_order — which IS the matching
// precedence.
// The six programs YMU actually runs (confirmed 2026-08-12), in sort_order —
// which IS the matching precedence.
const PROGRAMS: ProgramRow[] = [
  { id: "drumline", name: "Drumline", category: "Ensemble", sort_order: 10, match_patterns: ["drumline", "drum line", "drumlin", "drimline"] },
  { id: "modern", name: "Modern Band", category: "Ensemble", sort_order: 20, match_patterns: ["modern band", "mod band", "guitar", "jazz band", "jazz rhythm", "rhythm section"] },
  { id: "beginning", name: "Beginning Band", category: "Ensemble", sort_order: 30, match_patterns: ["beginning band", "beginner band", "winds", "concert band", "marching band"] },
  { id: "production", name: "Music Production", category: "Production", sort_order: 40, match_patterns: ["music production", "production", "daw", "beatmaking"] },
  { id: "pitch", name: "Pitch & Rhythm", category: "NonFixed", sort_order: 50, match_patterns: ["pitch & rhythm", "pitch and rhythm", "p+r", "p + r"] },
  { id: "afterschool", name: "After School", category: "NonFixed", sort_order: 900, match_patterns: ["after school", "afterschool", "tutoring", "rock ensemble", "jazz ensemble", "fusion", "orchestra", "strings", "ensemble", "asd", "special"] },
];

describe("matchProgram", () => {
  it("matches the bare program titles that make up most of the calendar", () => {
    expect(matchProgram("Drumline", PROGRAMS)?.id).toBe("drumline");
    expect(matchProgram("Music Production", PROGRAMS)?.id).toBe("production");
    expect(matchProgram("Beginning Band", PROGRAMS)?.id).toBe("beginning");
    expect(matchProgram("Modern Band", PROGRAMS)?.id).toBe("modern");
  });

  // YMU's own mapping, not an inference: guitar and jazz-with-a-rhythm-section
  // are taught as Modern Band, and every other ensemble is After School.
  it("folds guitar and jazz rhythm into Modern Band", () => {
    expect(matchProgram("Guitar", PROGRAMS)?.id).toBe("modern");
    expect(matchProgram("Guitar class - Edison", PROGRAMS)?.id).toBe("modern");
    expect(matchProgram("Jazz Band", PROGRAMS)?.id).toBe("modern");
    expect(matchProgram("Jazz rhythm section", PROGRAMS)?.id).toBe("modern");
  });

  it("folds the other ensembles into After School", () => {
    expect(matchProgram("Rock Ensemble", PROGRAMS)?.id).toBe("afterschool");
    expect(matchProgram("Jazz Ensemble", PROGRAMS)?.id).toBe("afterschool");
    expect(matchProgram("Fusion Ensemble", PROGRAMS)?.id).toBe("afterschool");
    expect(matchProgram("Orchestra", PROGRAMS)?.id).toBe("afterschool");
  });

  it("ignores the school-name suffix staff append", () => {
    expect(matchProgram("Modern Band - Horace Mann Middle School", PROGRAMS)?.id).toBe("modern");
    expect(matchProgram("Lake Stevens Middle - Drumline", PROGRAMS)?.id).toBe("drumline");
    expect(matchProgram("Beginning Band 1 - DHM/WLR", PROGRAMS)?.id).toBe("beginning");
  });

  // The reason sort_order is load-bearing. Every one of these titles contains
  // "band"; resolving them by whichever row is scanned first would be wrong
  // for three of the four.
  it("prefers the more specific band variant", () => {
    // Every one of these contains "band"; Modern Band is scanned before
    // Beginning Band, so "jazz band" must not be swallowed by a looser rule.
    expect(matchProgram("Jazz Band", PROGRAMS)?.id).toBe("modern");
    expect(matchProgram("Marching Band", PROGRAMS)?.id).toBe("beginning");
    expect(matchProgram("Concert Band", PROGRAMS)?.id).toBe("beginning");
  });

  it("is case-insensitive, because staff titles are not consistent", () => {
    expect(matchProgram("Jazz BAnd", PROGRAMS)?.id).toBe("modern");
    expect(matchProgram("DRUMLINE", PROGRAMS)?.id).toBe("drumline");
  });

  // Real typos, found in the live data: "Drumlin" x75 and "Drimline" x49.
  // Adding them to the patterns was cheaper than asking 111 schools to fix
  // their calendars.
  it("absorbs the typos that actually occur", () => {
    expect(matchProgram("Drumlin", PROGRAMS)?.id).toBe("drumline");
    expect(matchProgram("Drimline", PROGRAMS)?.id).toBe("drumline");
  });

  it("understands the P+R abbreviation for Pitch & Rhythm", () => {
    expect(matchProgram("P+R - North Glade Elementary", PROGRAMS)?.id).toBe("pitch");
    expect(matchProgram("Pitch & Rhythm", PROGRAMS)?.id).toBe("pitch");
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(matchProgram("Myrtle Grove Elementary", PROGRAMS)).toBeNull();
    expect(matchProgram("", PROGRAMS)).toBeNull();
    expect(matchProgram(null, PROGRAMS)).toBeNull();
    expect(matchProgram(undefined, PROGRAMS)).toBeNull();
  });

  it("returns null when there are no programs at all", () => {
    expect(matchProgram("Drumline", [])).toBeNull();
  });
});

describe("groupTopicsByPillar", () => {
  it("keeps pillars in the order the query returned them", () => {
    const grouped = groupTopicsByPillar([
      { pillar_category: "Rudiments & Technical", topic_name: "Rudiment #3" },
      { pillar_category: "Cadences & Repertoire", topic_name: "Cadence #1" },
      { pillar_category: "Rudiments & Technical", topic_name: "Chromatic Scale" },
    ]);
    expect([...grouped.keys()]).toEqual(["Rudiments & Technical", "Cadences & Repertoire"]);
    expect(grouped.get("Rudiments & Technical")).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(groupTopicsByPillar([]).size).toBe(0);
  });
});

describe("issueCategoryFor", () => {
  it("splits the PRD's operational and academic subcategories", () => {
    expect(issueCategoryFor("instruments")).toBe("Operational");
    expect(issueCategoryFor("behavior")).toBe("Operational");
    expect(issueCategoryFor("repertoire")).toBe("Academic");
    expect(issueCategoryFor("coaching")).toBe("Academic");
  });

  // Operational is the safe default: it is where the Regional Manager already
  // looks, and a mislabelled Academic ticket would quietly skew the PD
  // planning aggregates this field exists to feed.
  it("defaults an unknown subcategory to Operational", () => {
    expect(issueCategoryFor("something-else")).toBe("Operational");
    expect(issueCategoryFor(null)).toBe("Operational");
  });
});

describe("resolveProgram", () => {
  // The teacher is no longer asked which program it was, so there is nobody to
  // resolve a null — an unmatched title has to land somewhere, and After
  // School is the catch-all YMU nominated.
  it("falls back to After School when nothing matches", () => {
    expect(resolveProgram("Walkthrough - Morningside K-8", PROGRAMS)?.id).toBe("afterschool");
    expect(resolveProgram("Evaluations", PROGRAMS)?.id).toBe("afterschool");
    expect(resolveProgram(null, PROGRAMS)?.id).toBe("afterschool");
  });

  it("still prefers a real match over the fallback", () => {
    expect(resolveProgram("Drumline - Carol City Middle", PROGRAMS)?.id).toBe("drumline");
  });

  // Guards the one case where there is no fallback to reach for.
  it("returns null when After School itself is missing", () => {
    expect(resolveProgram("anything", PROGRAMS.filter((p) => p.id !== "afterschool"))).toBeNull();
  });
});
