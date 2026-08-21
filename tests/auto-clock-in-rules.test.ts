// Guards on migration 0077's seed and its two time windows.
//
// The detection itself is SQL, so it cannot be exercised here — it was
// verified by dry-running the candidate query against production data pinned
// to 10:52 ET on 2026-08-20, which returned exactly one row (Kevin Bodniza's
// 10:50 Music Production, GPS carried from the 09:10 session, 177 m from the
// school inside a 200 m geofence). What IS worth pinning in a test is the
// blast radius: which runs ship switched ON, and the two constants that decide
// what counts as back-to-back.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0077_auto_clock_in_back_to_back.sql",
  "utf8",
);

describe("the seeded rules", () => {
  // 23 runs were detected. YMU chose two and asked for the rest to stay off
  // until they had spoken to the regions — Carol City and Little River
  // especially, which have more flags than either of these. A seed row added
  // here is a clock-in that stops being asked for at a school nobody agreed
  // to, so it should be hard to add by accident.
  const seeded = [...migration.matchAll(/^\s*\('([^']+)', '([^']+)',$/gm)].map(
    ([, school, teacher]) => `${teacher} @ ${school}`,
  );

  it("ships exactly the two runs YMU approved", () => {
    expect(seeded).toEqual([
      "Kevin Bodniza @ Horace Mann Middle School",
      "Jose Heredia @ South Dade Middle School",
    ]);
  });

  it("leaves the runs YMU is still deciding on alone", () => {
    for (const school of ["Carol City", "Little River", "Madison", "Benjamin Franklin", "Lillie C. Evans"]) {
      expect(seeded.some((row) => row.includes(school))).toBe(false);
    }
  });

  it("explains every rule it seeds", () => {
    // note is nullable on the table but a rule that suppresses evidence of
    // attendance should never be unexplained.
    const notes = [...migration.matchAll(/^\s*'([^']*YMU 2026[^']*)'\),?$/gm)];
    expect(notes).toHaveLength(seeded.length);
  });
});

describe("what counts as back-to-back", () => {
  it("looks no further than 30 minutes ahead", () => {
    // Omar Cuellar's two Morningside blocks are 30 minutes apart and are the
    // only run at the boundary. Widening this sweeps in classes a teacher
    // genuinely leaves the building between.
    expect(migration).toContain("b.start_at <= a.end_at + interval '30 minutes'");
  });

  it("tolerates a 5-minute overlap", () => {
    // Little River's Tutoring is scheduled to start five minutes BEFORE
    // Beginning Band ends. That is a scheduling error, but the teacher is
    // still in the building, so the pair has to be detectable.
    expect(migration).toContain("b.start_at >= a.end_at - interval '5 minutes'");
  });

  it("defaults a rule's gap wider than the widest run it ships for", () => {
    // The seeded runs have 5-minute gaps; the Wednesday bell schedule shifts
    // every run by a few minutes, and a default at the observed gap would let
    // that quietly take a rule out of range.
    expect(migration).toContain("max_gap_minutes integer not null default 15");
  });
});

describe("the session it writes", () => {
  it("is distinguishable from a real clock-in", () => {
    expect(migration).toContain(
      "check (origin in ('online', 'offline', 'admin', 'exempt', 'carryover'))",
    );
  });

  it("still owes feedback", () => {
    // Unlike an exempt teacher (0052), a teacher on a back-to-back run taught
    // the class and the 24-hour deadline applies exactly as it would have.
    expect(migration).toContain("v_row.end_at + interval '24 hours'");
    expect(migration).not.toContain("feedback_settled_at");
  });

  it("runs before detection, and says so where it is called", () => {
    const edgeFunction = readFileSync("supabase/functions/late-detect/index.ts", "utf8");
    const carryover = edgeFunction.indexOf("auto_clock_in_back_to_back");
    const detect = edgeFunction.indexOf("detect_late_clockins");
    expect(carryover).toBeGreaterThan(-1);
    expect(carryover).toBeLessThan(detect);
  });
});
