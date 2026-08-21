// The third failure this bundle hit in YMU's SQL editor:
//
//   ERROR: 42601: too many parameters specified for RAISE
//   CONTEXT: compilation of PL/pgSQL function "inline_code_block" near line 108
//
// `%%` in a RAISE format string is an ESCAPED LITERAL PERCENT, not two
// placeholders. 0083 wrote:
//
//   raise exception
//     'Policy % changed ... Rolling back.%before: %%after:  %',
//     v_key, chr(10), v_before->>v_key, chr(10), v_after->>v_key;
//
// which reads as four placeholders against five arguments. PL/pgSQL checks this
// at COMPILE time, so it fails the moment the block is parsed — before a single
// statement runs, and with a line number pointing inside a DO block rather than
// at a migration file.
//
// That is a mistake no amount of reading catches reliably and no database is
// needed to catch: count the placeholders, count the arguments, compare.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "supabase/migrations";

/**
 * Split on commas at paren-depth zero and outside string literals, so
 * `format('%s', a)` and `coalesce(x, y)` count as one argument each.
 *
 * PL/pgSQL doubles a quote to escape it inside a literal ('it''s'), which is
 * why the quote handling looks ahead one character.
 */
function topLevelSplit(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buffer = "";
  let quote: string | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        if (input[index + 1] === quote) {
          buffer += char + char;
          index += 1;
          continue;
        }
        quote = null;
      }
      buffer += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;

    if (char === "," && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

/**
 * How many arguments a RAISE format string consumes. `%`, `%I` and `%L` each
 * take one; `%%` takes none.
 */
function countPlaceholders(format: string): number {
  let count = 0;
  for (let index = 0; index < format.length; index += 1) {
    if (format[index] !== "%") continue;
    if (format[index + 1] === "%") {
      index += 1; // an escaped literal percent — consumes no argument
      continue;
    }
    count += 1;
  }
  return count;
}

type Raise = {
  migration: string;
  line: number;
  format: string;
  placeholders: number;
  args: number;
};

function raiseStatements(): Raise[] {
  const found: Raise[] = [];
  for (const name of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${DIR}/${name}`, "utf8");
    for (const match of sql.matchAll(/\braise\s+(?:exception|notice|warning)\s+([\s\S]*?);/gi)) {
      const parts = topLevelSplit(match[1]);
      const format = parts[0] ?? "";
      // Only literal format strings can be checked statically. A RAISE whose
      // message is built by concatenation or format() is skipped rather than
      // guessed at.
      if (!/^E?'/i.test(format)) continue;
      const body = format.slice(format.indexOf("'") + 1, format.lastIndexOf("'"));
      found.push({
        migration: name,
        line: sql.slice(0, match.index).split("\n").length,
        format: body,
        placeholders: countPlaceholders(body),
        args: parts.length - 1,
      });
    }
  }
  return found;
}

describe("RAISE statements in migrations", () => {
  const statements = raiseStatements();

  it("finds them at all", () => {
    // A guard on the guard: if the matcher breaks, every assertion below passes
    // vacuously.
    expect(statements.length).toBeGreaterThan(20);
  });

  it("passes exactly as many arguments as the format string consumes", () => {
    const offenders = statements
      .filter((statement) => statement.placeholders !== statement.args)
      .map(
        (statement) =>
          `${statement.migration}:${statement.line} — ${statement.placeholders} placeholder(s), ` +
          `${statement.args} argument(s): "${statement.format.slice(0, 70)}"`,
      );

    // Named rather than counted: PL/pgSQL reports this as a line inside an
    // anonymous code block, which tells you nothing about which file to open.
    expect(offenders).toEqual([]);
  });

  it("counts %% as a literal, not as two placeholders", () => {
    // The exact confusion that caused the failure, pinned as a unit test on the
    // counter itself.
    expect(countPlaceholders("a % b")).toBe(1);
    expect(countPlaceholders("a %% b")).toBe(0);
    expect(countPlaceholders("a %%b: %")).toBe(1);
    expect(countPlaceholders("%I on %I%s%s")).toBe(4);
    expect(countPlaceholders("100%% done, % left")).toBe(1);
  });

  it("splits arguments at paren depth zero", () => {
    // The other half of the comparison. A nested comma is not an argument
    // boundary, or every RAISE with a coalesce() in it would read as balanced
    // when it is not.
    expect(topLevelSplit("'x %', a, b")).toHaveLength(3);
    expect(topLevelSplit("'x %', coalesce(a, b)")).toHaveLength(2);
    expect(topLevelSplit("'x, y %', a")).toHaveLength(2);
  });
});
