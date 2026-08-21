// Nothing in this suite touched the spreadsheet exporters before now, which is
// a strange gap for the one part of the app whose failure mode is "plausible
// data under the wrong heading". The import-time length throws in
// sheet-tabs.ts and feedback-sheet-columns.ts were the only guard, and neither
// names the tab that broke or notices a tab pointing at an RPC that does not
// exist.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHEET_TABS, toTabRow } from "../src/lib/google/sheet-tabs";
import { COLUMNS, HEADER } from "../src/lib/google/feedback-sheet-columns";

const migrations = readdirSync("supabase/migrations")
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(`supabase/migrations/${name}`, "utf8"))
  .join("\n");

describe("every tab", () => {
  it.each(SHEET_TABS.map((tab) => [tab.name, tab] as const))(
    "%s has one header per column",
    (_name, tab) => {
      expect(tab.header).toHaveLength(tab.columns.length);
    },
  );

  it.each(SHEET_TABS.map((tab) => [tab.name, tab] as const))(
    "%s names each column once",
    (_name, tab) => {
      expect(new Set(tab.columns).size).toBe(tab.columns.length);
    },
  );

  it.each(SHEET_TABS.map((tab) => [tab.name, tab] as const))(
    "%s labels each heading once",
    (_name, tab) => {
      // Two identical headings is not a crash, it is a spreadsheet where a
      // pivot silently picks the wrong one.
      expect(new Set(tab.header).size).toBe(tab.header.length);
    },
  );

  // A tab whose rpc does not exist does not error — overwriteRows writes the
  // header and clears the body, so the tab goes empty and looks like a quiet
  // week.
  it.each(SHEET_TABS.map((tab) => [tab.name, tab.rpc] as const))(
    "%s points at a function that exists (%s)",
    (_name, rpc) => {
      expect(migrations).toContain(`function public.${rpc}(`);
    },
  );

  it("uses a distinct tab name per entry", () => {
    // Changing or colliding a name strands the old tab's data in place.
    const names = SHEET_TABS.map((tab) => tab.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("toTabRow", () => {
  const tab = SHEET_TABS[0];

  it("orders values by the tab's column list, not the object's keys", () => {
    const row = Object.fromEntries(
      [...tab.columns].reverse().map((key, index) => [key, `v${index}`]),
    );
    const expected = tab.columns.map((key) => row[key]);
    expect(toTabRow(tab, row)).toEqual(expected);
  });

  it("writes an empty cell for null and undefined, not the word null", () => {
    expect(toTabRow(tab, {})).toEqual(tab.columns.map(() => ""));
    expect(toTabRow(tab, { [tab.columns[0]]: null })[0]).toBe("");
  });

  it("passes numbers and booleans through unstringified", () => {
    // USER_ENTERED means a stringified number still lands as a number, but a
    // stringified boolean lands as text and breaks a filter.
    expect(toTabRow(tab, { [tab.columns[0]]: 0 })[0]).toBe(0);
    expect(toTabRow(tab, { [tab.columns[0]]: false })[0]).toBe(false);
  });
});

describe("the Feedback tab's column order", () => {
  it("has one header per column", () => {
    expect(HEADER).toHaveLength(COLUMNS.length);
  });

  // This tab is APPEND-ONLY over 238 rows of history, so a position that moves
  // re-labels every row already written. This is the test that makes that
  // mistake loud.
  it("keeps focus_pillar in position 14", () => {
    expect(COLUMNS[13]).toBe("focus_pillar");
    expect(HEADER[13]).toContain("retired");
  });

  it("keeps the identity columns at the front", () => {
    expect(COLUMNS.slice(0, 4)).toEqual([
      "id",
      "submitted_at",
      "class_date",
      "class_time",
    ]);
  });

  it("names each column once", () => {
    expect(new Set(COLUMNS).size).toBe(COLUMNS.length);
  });
});

describe("the Attendance tab", () => {
  const attendance = SHEET_TABS.find((tab) => tab.name === "Attendance")!;

  it("no longer hardcodes the school year", () => {
    // The bounds were 2026-08-01 -> 2027-07-01 in this file. On 2027-07-01 the
    // tab would have rewritten itself to zero rows in silence.
    expect(attendance.args).toBeUndefined();
    expect(JSON.stringify(attendance)).not.toContain("2027-07-01");
  });

  it("says in the heading that Hours is the scheduled length", () => {
    // The calculation is (end_at - start_at), so a teacher who clocked in
    // forty minutes late shows full hours. YMU asked for the number left
    // alone; the heading has to carry the caveat instead.
    expect(attendance.header).toContain("Hours (scheduled)");
  });

  it("carries the manager edit trail", () => {
    for (const key of ["edited_by", "edited_at", "edit_reason"]) {
      expect(attendance.columns).toContain(key);
    }
  });
});
