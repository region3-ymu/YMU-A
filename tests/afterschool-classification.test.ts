// classify_afterschool() (migration 0063) against the titles that are actually
// in YMU's calendars, plus the ones that must NOT match.
//
// Service-role only: the function reads afterschool_patterns and nothing else,
// so this suite needs no disposable users and none of the auth round-trips the
// RLS suites pay for.
//
// Every "real" case below was taken from a live row, spelling and all. That is
// the point of the suite: the rule exists because the titles are messy, so
// testing it against tidied-up titles would test nothing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Rely on ambient env in CI-like environments.
  }
}

loadEnvLocal();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && serviceKey);

// Explicit offsets rather than a bare local time. The cutoff is defined in
// America/New_York, and a machine running the suite in UTC would otherwise
// shift every case by four hours and "prove" the wrong thing.
const EDT = "-04:00"; // summer, when school starts
const EST = "-05:00"; // winter, to show the comparison follows the zone

function at(time: string, offset = EDT, date = "2026-09-15") {
  return `${date}T${time}:00${offset}`;
}

describe.runIf(configured)("classify_afterschool", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function classify(summary: string | null, startAt: string | null) {
    const { data, error } = await admin.rpc("classify_afterschool", {
      p_summary: summary,
      p_start_at: startAt,
    });
    if (error) throw new Error(`classify_afterschool failed: ${error.message}`);
    return data as boolean;
  }

  describe("strong patterns — the title decides, whatever the clock says", () => {
    const cases: [string, string][] = [
      // Both spellings. 2025-26 wrote two words, 2026-27 writes one, and YMU
      // asked for both to keep working.
      ["Afterschool", "15:00"],
      ["After School", "15:00"],
      ["After School Tutoring", "14:15"],
      ["After School - Tutoring", "14:00"],
      ["Extra After School", "16:00"],
      // A live typo at Little River, 36 events.
      ["Aftreschool", "15:00"],
      // A live trailing space at YMPA — one of its two afterschool sections.
      ["Afterschool ", "15:00"],
      ["Afterschool Program", "16:00"],
      ["Afterschool - Carol City Senior High", "15:00"],
      ["Tutoring", "13:50"],
      ["After School Marching Band (T/Th)", "15:00"],
      ["After School Rock Ensemble Fienberg", "14:00"],
      // The Feinberg/Fienberg misspelling is in the calendar too.
      ["After School Rock Ensemble Feinberg", "15:10"],
      ["Rock Ensemble", "14:30"],
      ["Rock Ensemble - 2", "14:30"],
      ["Fusion Ensemble", "14:00"],
    ];

    for (const [summary, time] of cases) {
      it(`matches ${JSON.stringify(summary)} at ${time}`, async () => {
        expect(await classify(summary, at(time))).toBe(true);
      });
    }

    // The reason the cutoff cannot simply be applied to everything: these run
    // at midday and say afterschool on the tin.
    it("matches a midday class whose title says afterschool", async () => {
      expect(await classify("Marching Band - Afterschool", at("12:00"))).toBe(true);
      expect(await classify("Marching Band Afterschool", at("12:00"))).toBe(true);
      expect(await classify("Sunday Fusion", at("12:00"))).toBe(true);
    });

    it("is case-insensitive", async () => {
      expect(await classify("AFTERSCHOOL", at("15:00"))).toBe(true);
      expect(await classify("tUtOrInG", at("15:00"))).toBe(true);
    });
  });

  describe("weak patterns — ambiguous, so the clock breaks the tie", () => {
    it("takes an afternoon marching band", async () => {
      expect(await classify("Marching Band", at("15:00"))).toBe(true);
      expect(await classify("Marching Band", at("16:00"))).toBe(true);
    });

    // Homestead Middle, 180 events. YMU: "Si el marching band es de mañana no
    // es afterschool entonces."
    it("leaves Homestead Middle's morning marching band alone", async () => {
      expect(await classify("Marching Band", at("07:40"))).toBe(false);
      expect(await classify("Marching Band", at("09:18"))).toBe(false);
      expect(await classify("Marching Band", at("09:22"))).toBe(false);
    });

    it("leaves Homestead Senior's late-morning one alone", async () => {
      expect(await classify("Marching Band", at("10:30"))).toBe(false);
    });

    it("leaves a midday marching band alone when the title does not say afterschool", async () => {
      expect(await classify("Marching Band", at("12:00"))).toBe(false);
      expect(await classify("Modern Band/Marching Band", at("12:30"))).toBe(false);
    });

    it("treats 13:30 as the boundary, inclusive", async () => {
      expect(await classify("Marching Band", at("13:29"))).toBe(false);
      expect(await classify("Marching Band", at("13:30"))).toBe(true);
    });

    // The cutoff is a fact about the school's clock. A UTC comparison would
    // drift by an hour between August and January and quietly reclassify a
    // winter class.
    it("reads the clock in America/New_York, not UTC", async () => {
      // 13:00 EST = 18:00 UTC. Before the cutoff locally, after it in UTC.
      expect(await classify("Marching Band", at("13:00", EST, "2027-01-20"))).toBe(false);
      expect(await classify("Marching Band", at("14:00", EST, "2027-01-20"))).toBe(true);
    });
  });

  describe("never afterschool", () => {
    // YMU 2026-08-18: ASD is a regular class and stays with its region's RM.
    it("ignores ASD and special", async () => {
      expect(await classify("ASD", at("09:00"))).toBe(false);
      expect(await classify("ASD", at("16:00"))).toBe(false);
      expect(await classify("Special", at("16:00"))).toBe(false);
    });

    // These are what the generic word "ensemble" would have swept in. They are
    // school-hours classes, and leaving that pattern out is what keeps them out
    // without an exception list.
    it("ignores the jazz classes that run during school hours", async () => {
      expect(await classify("Jazz Ensamble", at("10:10"))).toBe(false);
      expect(await classify("Jazz", at("11:10"))).toBe(false);
      expect(await classify("Jazz Band Rhythm Section", at("11:25"))).toBe(false);
      expect(await classify("Jazz Band", at("11:45"))).toBe(false);
    });

    // The 754 events that only ever landed on the After School program because
    // resolveProgram() had nowhere else to put them. Routing on program_id
    // would have handed all of this to her.
    it("ignores the catch-all junk", async () => {
      for (const junk of [
        "Walkthrough - Morningside K-8",
        "Equipment",
        "Evaluations",
        "Spring Concert",
        "Concert",
        "Performance",
        "TEST - Name of Class",
        "Seed Test Class",
        "Richard Padron",
        "David Maden",
        "Kelsey Pharr Elementary - Camila Olmos",
        "Band (Rotating)",
        "Beg Band- LATIN FOCUS",
        "Orchdestra",
      ]) {
        expect(await classify(junk, at("09:00")), junk).toBe(false);
      }
    });

    it("ignores the regular programs", async () => {
      for (const title of [
        "Drumline",
        "Modern Band",
        "Beginning Band",
        "Music Production",
        "Pitch & Rhythm",
        "Beginner Strings",
      ]) {
        expect(await classify(title, at("15:00")), title).toBe(false);
      }
    });

    it("is false rather than null for a missing title or time", async () => {
      expect(await classify(null, at("15:00"))).toBe(false);
      expect(await classify("", at("15:00"))).toBe(false);
      // A weak match with no start time cannot clear the cutoff.
      expect(await classify("Marching Band", null)).toBe(false);
      // A strong match still needs a start time for afterschool_owned()'s
      // school-year window, but classification itself does not care.
      expect(await classify("Afterschool", null)).toBe(true);
    });
  });
});
