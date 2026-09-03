// A static guard for the migration bug that reached YMU's SQL editor:
//
//   ERROR: 42P13: cannot change return type of existing function
//   DETAIL: Row type defined by OUT parameters is different.
//   HINT: Use DROP FUNCTION flags_for_sheet() first.
//
// `create or replace function` can change a body freely. It CANNOT change the
// return type — and for a `returns table (...)` function, adding or removing a
// single column is a return-type change. 0078 added four columns to
// flags_for_sheet and 0080 added six more; both were written as plain
// create-or-replace and both would have failed.
//
// This is exactly the class of mistake that survives code review (the SQL is
// valid, the diff looks right) and only shows up against a database that
// already has the old shape. So it gets a test that needs no database: walk the
// migrations in order, and every time a `returns table` function is redefined
// after its first definition, require a DROP for it earlier in the same file.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Definition = {
  migration: string;
  fn: string;
  /** The declared column list, normalised — this is what may not change. */
  shape: string;
  hasDrop: boolean;
};

const DIR = "supabase/migrations";

function migrations(): { name: string; sql: string }[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${DIR}/${name}`, "utf8") }));
}

/**
 * Strips a `returns table (...)` column list down to something comparable:
 * comments out, whitespace collapsed, lowercased. Two definitions with the same
 * normalised shape are a legal `create or replace`; a different shape is the
 * 42P13 error.
 */
function normaliseShape(columnList: string): string {
  return columnList
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Every `create or replace function public.x(...) returns table (...)` in the
 * repo, in migration order, with its normalised column list and whether a
 * `drop function if exists x` appears before it in the same file.
 *
 * Only `returns table` is examined. A scalar or row-type return
 * (`returns public.flags`) replaces in place happily as long as that type is
 * unchanged, and those are stable across this repo's history.
 */
function tableReturningDefinitions(): Definition[] {
  const found: Definition[] = [];
  for (const { name, sql } of migrations()) {
    const pattern =
      /create or replace function public\.(\w+)\s*\([^;]*?\)\s*\r?\n\s*returns table\s*\(/gi;
    for (const match of sql.matchAll(pattern)) {
      const fn = match[1];
      const listStart = (match.index ?? 0) + match[0].length;

      // Walk to the matching close paren rather than regexing it: a column list
      // contains nested parens (numeric(10,2), timestamp with time zone).
      let depth = 1;
      let cursor = listStart;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === "(") depth += 1;
        else if (sql[cursor] === ")") depth -= 1;
        cursor += 1;
      }

      const before = sql.slice(0, match.index);
      found.push({
        migration: name,
        fn,
        shape: normaliseShape(sql.slice(listStart, cursor - 1)),
        hasDrop: new RegExp(`drop function if exists public\\.${fn}\\s*\\(`, "i").test(before),
      });
    }
  }
  return found;
}

describe("returns-table functions that get redefined", () => {
  const definitions = tableReturningDefinitions();

  it("finds the table-returning functions at all", () => {
    // A guard on the guard: if the regex stops matching, every assertion below
    // passes vacuously and the test becomes decoration.
    expect(definitions.length).toBeGreaterThan(5);
    expect(definitions.map((d) => d.fn)).toContain("flags_for_sheet");
  });

  it("drops before redefining with a different column list", () => {
    const lastShape = new Map<string, string>();
    const offenders: string[] = [];

    for (const definition of definitions) {
      const previous = lastShape.get(definition.fn);
      // Same shape is a legal create-or-replace — only the body changed, which
      // is how most of this repo\'s history redefines a function.
      if (previous !== undefined && previous !== definition.shape && !definition.hasDrop) {
        offenders.push(
          `${definition.migration} changes ${definition.fn}()'s columns without dropping it first`,
        );
      }
      lastShape.set(definition.fn, definition.shape);
    }

    // Named rather than counted, so a failure says which migration to fix.
    expect(offenders).toEqual([]);
  });

  it("recognises a body-only redefinition as legal", () => {
    // The test of the test, and the reason the rule compares column lists
    // rather than just counting redefinitions. find_substitutes() is redefined
    // in 0061 with no drop and has always worked: 0061 narrowed its coverage
    // window to the current school year, which is a body change with an
    // identical column list. If the shape parser were broken this would read as
    // a change and the rule above would be crying wolf on several historical
    // migrations that are all correct.
    //
    // 0093 is the one genuine shape change (adding late_minutes) — it drops
    // first, same pattern as teacher_directory() below, so every redefinition
    // apart from that one is still a legal body-only change with no drop.
    const stable = definitions.filter((d) => d.fn === "find_substitutes");
    expect(stable.length).toBeGreaterThan(2);
    expect(new Set(stable.map((d) => d.shape)).size).toBe(2);
    const changed = stable.find(
      (d, index) => index > 0 && d.shape !== stable[index - 1].shape,
    );
    expect(changed?.migration).toBe("0093_substitute_late_grace_and_real_drive_times.sql");
    expect(changed?.hasDrop).toBe(true);
    expect(stable.filter((d) => d !== changed).every((d) => !d.hasDrop)).toBe(true);
  });

  it("catches a genuine shape change that WAS handled correctly", () => {
    // teacher_directory() is defined five times across the repo and its column
    // list moves exactly once, in 0021 — which drops first. That migration is
    // the pattern 0078 and 0080 should have followed from the start, and this
    // asserts the parser sees both halves of it.
    const directory = definitions.filter((d) => d.fn === "teacher_directory");
    expect(new Set(directory.map((d) => d.shape)).size).toBe(2);
    const changed = directory.find(
      (d, index) => index > 0 && d.shape !== directory[index - 1].shape,
    );
    expect(changed?.migration).toBe("0021_report_hours_flag_resolve_teacher_regions.sql");
    expect(changed?.hasDrop).toBe(true);
  });

  // The three that actually bit, pinned by name. The rule above would catch
  // them, but these make the regression concrete: if someone "tidies up" a
  // drop, this is the test that explains why it was there.
  it.each([
    ["0078_sheet_export_gaps.sql", "flags_for_sheet"],
    ["0078_sheet_export_gaps.sql", "attendance_for_sheet"],
    ["0080_missed_clock_in_detail.sql", "flags_for_sheet"],
  ])("%s drops %s() before recreating it", (migration, fn) => {
    const definition = definitions.find((d) => d.migration === migration && d.fn === fn);
    expect(definition, `${fn}() not found in ${migration}`).toBeDefined();
    expect(definition!.hasDrop).toBe(true);
  });

  // Dropping a function drops its grants with it. A sheet exporter that comes
  // back without `grant ... to service_role` is a tab that silently syncs
  // nothing, which is the failure mode sheet-tabs.ts cannot detect.
  it("regrants anything it drops", () => {
    for (const { name, sql } of migrations()) {
      for (const match of sql.matchAll(/drop function if exists public\.(\w+)\s*\(/gi)) {
        const fn = match[1];
        const recreated = new RegExp(
          `create or replace function public\\.${fn}\\s*\\(`,
          "i",
        ).test(sql);
        if (!recreated) continue; // A permanent removal needs no grant.
        expect(
          new RegExp(`grant execute on function public\\.${fn}\\(`, "i").test(sql),
          `${name} drops and recreates ${fn}() without regranting execute`,
        ).toBe(true);
      }
    }
  });

  // Dropping a function drops its grants with it. A sheet exporter that comes
  // back without `grant ... to service_role` is a tab that silently syncs
  // nothing, which is the failure mode sheet-tabs.ts cannot detect.
  it("regrants anything it drops", () => {
    for (const { name, sql } of migrations()) {
      for (const match of sql.matchAll(/drop function if exists public\.(\w+)\s*\(/gi)) {
        const fn = match[1];
        const recreated = new RegExp(
          `create or replace function public\\.${fn}\\s*\\(`,
          "i",
        ).test(sql);
        if (!recreated) continue; // A permanent removal needs no grant.
        expect(
          new RegExp(`grant execute on function public\\.${fn}\\(`, "i").test(sql),
          `${name} drops and recreates ${fn}() without regranting execute`,
        ).toBe(true);
      }
    }
  });
});

// The second failure this bundle hit in YMU's SQL editor:
//
//   ERROR: 2BP01: cannot drop table gps_checks because other objects depend on it
//   DETAIL: function apply_gps_sample(...) depends on type gps_checks
//   HINT: Use DROP ... CASCADE to drop the dependent objects too.
//
// A function that RETURNS a table's row type is a hard dependency on that
// table. 0082 named two such functions and missed a third — the shared
// implementation the other two wrap. Guessing the set twice is what earned
// these tests.
describe("dropping a table", () => {
  const removal = readFileSync(`${DIR}/0082_remove_gps_checks.sql`, "utf8");

  it("finds its dependent functions by return type instead of naming them", () => {
    // The list-by-hand approach failed. This asserts the migration asks
    // pg_proc which functions return the row type rather than remembering.
    expect(removal).toMatch(/join pg_type t on t\.oid = p\.prorettype/);
    expect(removal).toContain("t.typname = 'gps_checks'");
  });

  it("does not name the functions it sweeps", () => {
    // If someone re-adds these as explicit drops, the sweep stops being the
    // single source of truth and the next apply_gps_sample gets missed again.
    for (const fn of ["record_gps_check(", "record_gps_check_offline(", "apply_gps_sample("]) {
      expect(
        removal.includes(`drop function if exists public.${fn}`),
        `0082 should let the return-type sweep remove ${fn}) rather than naming it`,
      ).toBe(false);
    }
  });

  it("refuses CASCADE", () => {
    // Postgres's own hint suggests CASCADE, and taking it would have silently
    // dropped whatever else had come to depend on the table — which is exactly
    // the thing worth being told about. A plain DROP either succeeds or reports
    // something genuinely unexpected.
    expect(removal).not.toMatch(/drop table[^;]*cascade/i);
  });

  it("drops the referencing column before the table", () => {
    // flags.gps_check_id carries the foreign key. Dropping the column takes
    // the constraint with it; the other order fails.
    const column = removal.indexOf("alter table public.flags drop column if exists gps_check_id");
    const table = removal.indexOf("drop table if exists public.gps_checks");
    expect(column).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(-1);
    expect(column).toBeLessThan(table);
  });

  it("unschedules the cron before dropping what it calls", () => {
    // Otherwise check-closeout-1min errors 1,440 times a day until someone
    // redeploys the Edge Function.
    const unschedule = removal.indexOf("cron.unschedule");
    const dropFunctions = removal.indexOf("drop function if exists public.close_out_overdue_gps_checks");
    expect(unschedule).toBeGreaterThan(-1);
    expect(unschedule).toBeLessThan(dropFunctions);
  });
});
