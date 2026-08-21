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
  // 23 runs were detected. YMU approved six of them (2026-08-21) and the rest
  // stay off behind a toggle on /schedules. A seed row added here is a
  // clock-in that stops being asked for at a school nobody agreed to, so it
  // should be hard to add by accident.
  const seeded = [
    ...migration.matchAll(
      /^\s*\('([^']+)', '([^']+)', (null|'[a-z]+'), (null|'[a-z]+'),$/gm,
    ),
  ].map(([, school, teacher, first, second]) => ({
    run: `${teacher} @ ${school}`,
    first: first === "null" ? null : first.replaceAll("'", ""),
    second: second === "null" ? null : second.replaceAll("'", ""),
  }));

  it("ships exactly the six runs YMU approved", () => {
    expect(seeded.map((row) => row.run)).toEqual([
      "Kevin Bodniza @ Horace Mann Middle School",
      "Jose Heredia @ South Dade Middle School",
      "Deion Hampton @ Carol City Middle School",
      "Jeff Joseph @ Carol City Middle School",
      "Gerdy Chevelon @ Carol City Middle School",
      "Reinaldo Velez @ Little River K-8",
    ]);
  });

  // The whole reason first_class_pattern exists. Reinaldo runs four classes
  // back to back at Little River and only the LAST link carries over —
  // Beginning Band into Tutoring keeps its own clock-in. An unscoped rule for
  // him would silently cover the earlier links too.
  it("scopes Reinaldo's rule to Tutoring into Afterschool only", () => {
    const reinaldo = seeded.find((row) => row.run.startsWith("Reinaldo Velez"));
    expect(reinaldo).toBeDefined();
    expect(reinaldo!.first).toBe("tutoring");
    expect(reinaldo!.second).toBe("afterschool");
  });

  it("leaves the runs YMU wants clocked in normally alone", () => {
    for (const school of ["Madison", "Benjamin Franklin", "Lillie C. Evans", "Norland", "Morningside"]) {
      expect(seeded.some((row) => row.run.includes(school))).toBe(false);
    }
  });

  // Little River appears once and only with patterns. An unscoped Little River
  // row would cover Beginning Band into Tutoring.
  it("never seeds an unscoped rule at Little River", () => {
    const littleRiver = seeded.filter((row) => row.run.includes("Little River"));
    expect(littleRiver).toHaveLength(1);
    expect(littleRiver.every((row) => row.first !== null && row.second !== null)).toBe(true);
  });

  it("explains every rule it seeds", () => {
    // note is nullable on the table but a rule that suppresses evidence of
    // attendance should never be unexplained.
    const notes = [...migration.matchAll(/^\s*'([^']*YMU 2026[^']*)'\),?$/gm)];
    expect(notes).toHaveLength(seeded.length);
  });
});

describe("one predicate, three callers", () => {
  // The sweep that writes the session, the detector that must not flag it, and
  // the screen that shows which runs are on all have to agree. Three
  // hand-rolled title matches would be three chances for the screen to say
  // "on" about a run the sweep does not cover.
  it("routes every rule decision through auto_clock_in_rule_gap", () => {
    const calls = [...migration.matchAll(/public\.auto_clock_in_rule_gap\(/g)];
    // One definition plus three call sites.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("matches a title as a case-insensitive substring", () => {
    // Calendar titles belong to the schools. Little River has "Tutoring",
    // "After School Tutoring" and "After School - Tutoring" live right now,
    // and 'aftreschool' is a real typo on 36 of their events — an exact match
    // would cover one spelling and miss the rest.
    expect(migration).toContain("position(lower(r.first_class_pattern) in lower(coalesce(p_first_class, ''))) > 0");
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
