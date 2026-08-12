// Regression tests for deriving a class's program from its calendar title.
//
// The cases here are real titles taken from the 8,986 live calendar_events
// rows, not invented ones. The whole approach rests on those titles already
// being program names, so the test data has to be the actual data.

import { describe, expect, it } from "vitest";
import { groupTopicsByPillar, issueCategoryFor, matchProgram, type ProgramRow } from "../src/lib/feedback/program-match";

// Mirrors the seed in migration 0030, in sort_order — which IS the matching
// precedence.
const PROGRAMS: ProgramRow[] = [
  { id: "marching", name: "Marching Band", category: "Ensemble", sort_order: 10, match_patterns: ["marching band"] },
  { id: "concert", name: "Concert Band", category: "Ensemble", sort_order: 20, match_patterns: ["concert band"] },
  { id: "beginning", name: "Beginning Band", category: "Ensemble", sort_order: 30, match_patterns: ["beginning band", "beginner band", "winds"] },
  { id: "modern", name: "Modern Band", category: "Ensemble", sort_order: 40, match_patterns: ["modern band", "mod band"] },
  { id: "jazz", name: "Jazz Band", category: "Ensemble", sort_order: 45, match_patterns: ["jazz band", "jazz"] },
  { id: "rock", name: "Rock Ensemble", category: "Ensemble", sort_order: 50, match_patterns: ["rock ensemble"] },
  { id: "fusion", name: "Fusion Ensemble", category: "Ensemble", sort_order: 55, match_patterns: ["fusion"] },
  { id: "drumline", name: "Drumline", category: "Ensemble", sort_order: 60, match_patterns: ["drumline", "drum line", "drumlin", "drimline"] },
  { id: "orchestra", name: "Orchestra", category: "Ensemble", sort_order: 70, match_patterns: ["orchestra", "strings"] },
  { id: "guitar", name: "Guitar", category: "Ensemble", sort_order: 80, match_patterns: ["guitar"] },
  { id: "production", name: "Music Production", category: "Production", sort_order: 90, match_patterns: ["music production", "production", "daw", "beatmaking"] },
  { id: "pitch", name: "Pitch & Rhythm", category: "NonFixed", sort_order: 100, match_patterns: ["pitch & rhythm", "pitch and rhythm", "p+r", "p + r"] },
  { id: "afterschool", name: "After School", category: "NonFixed", sort_order: 110, match_patterns: ["after school", "afterschool", "tutoring"] },
  { id: "asd", name: "ASD / Special", category: "NonFixed", sort_order: 120, match_patterns: ["asd", "special"] },
];

describe("matchProgram", () => {
  it("matches the bare program titles that make up most of the calendar", () => {
    expect(matchProgram("Drumline", PROGRAMS)?.id).toBe("drumline");
    expect(matchProgram("Music Production", PROGRAMS)?.id).toBe("production");
    expect(matchProgram("Beginning Band", PROGRAMS)?.id).toBe("beginning");
    expect(matchProgram("Modern Band", PROGRAMS)?.id).toBe("modern");
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
    expect(matchProgram("Marching Band", PROGRAMS)?.id).toBe("marching");
    expect(matchProgram("Concert Band", PROGRAMS)?.id).toBe("concert");
    expect(matchProgram("Jazz Band", PROGRAMS)?.id).toBe("jazz");
    expect(matchProgram("After School - Marching Band", PROGRAMS)?.id).toBe("marching");
  });

  it("is case-insensitive, because staff titles are not consistent", () => {
    expect(matchProgram("Jazz BAnd", PROGRAMS)?.id).toBe("jazz");
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
