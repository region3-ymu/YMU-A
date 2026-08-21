// The fourth failure, and the one that never reached YMU because the migration
// caught itself:
//
//   Policy profiles.profiles_update_own changed in more than its evaluation
//   order. Rolling back.
//     before: (id = ( SELECT auth.uid() AS uid))
//     after:  (id = ( SELECT ( SELECT auth.uid() AS uid) AS uid))
//
// 0083 wraps four identity functions in a scalar subquery so RLS evaluates them
// once per statement instead of once per row. One policy already had auth.uid()
// wrapped — somebody had applied the same optimisation there by hand — and a
// wrap-only pass nested it a second time.
//
// Two things are worth pinning as a result. The wrap has to be idempotent, and
// the migration's own invariant check has to stay, because it is the thing that
// turned a silent policy corruption into a rolled-back migration.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0083_rls_evaluate_once_per_query.sql",
  "utf8",
);

/**
 * A JS port of wrap_identity_calls' three passes, close enough to assert the
 * ORDER of operations. The authority is the SQL — this was verified against it
 * on production inside a rolled-back transaction, where
 * `(id = ( SELECT auth.uid() AS uid))` came back as `(id = (select auth.uid()))`
 * rather than nesting.
 */
function wrapIdentityCalls(expr: string): string {
  const names = "(?:public\\.)?(?:current_app_role|current_sees_all_regions|current_app_region|auth\\.uid)\\(\\)";
  return expr
    .replace(new RegExp(`\\(\\s*select\\s+(${names})(\\s+as\\s+[a-z_.]+)?\\s*\\)`, "gi"), "$1")
    .replace(
      /(^|[^A-Za-z0-9_.])((?:public\.)?(?:current_app_role|current_sees_all_regions|current_app_region)\(\))/g,
      "$1(select $2)",
    )
    .replace(/(^|[^A-Za-z0-9_.])(auth\.uid\(\))/g, "$1(select $2)");
}

describe("the RLS identity wrap", () => {
  it("unwraps before it wraps", () => {
    // The order IS the fix. If the unwrap pass ever moves after the wrap
    // passes, or disappears, the nesting comes back.
    const unwrap = migration.indexOf("(\\s*select\\s+((?:public\\.)?");
    const wrapNamed = migration.indexOf("'(^|[^[:alnum:]_.])((?:public\\.)?");
    const wrapUid = migration.indexOf("'(^|[^[:alnum:]_.])(auth\\.uid");
    expect(unwrap).toBeGreaterThan(-1);
    expect(unwrap).toBeLessThan(wrapNamed);
    expect(wrapNamed).toBeLessThan(wrapUid);
  });

  it("is idempotent on an already-wrapped policy", () => {
    // profiles.profiles_update_own, as Postgres renders it today.
    const rendered = "(id = ( SELECT auth.uid() AS uid))";
    expect(wrapIdentityCalls(rendered)).toBe("(id = (select auth.uid()))");
    expect(wrapIdentityCalls(wrapIdentityCalls(rendered))).toBe(
      wrapIdentityCalls(rendered),
    );
    expect(wrapIdentityCalls(rendered)).not.toContain("(select (select");
  });

  it("wraps a bare call to the same result as an already-wrapped one", () => {
    expect(wrapIdentityCalls("(id = auth.uid())")).toBe(wrapIdentityCalls("(id = ( SELECT auth.uid() AS uid))"));
  });

  it("leaves a real subquery alone while wrapping the call inside it", () => {
    // The unwrap pattern is deliberately narrow. If it ever widened enough to
    // eat `exists (select 1 from schools ...)`, RLS would silently lose a
    // region check.
    const policy = "exists (select 1 from schools s where s.region = current_app_region())";
    expect(wrapIdentityCalls(policy)).toBe(
      "exists (select 1 from schools s where s.region = (select current_app_region()))",
    );
  });

  it("never produces public.(select …)", () => {
    // A plain string replace would. The leading character class is what stops
    // it, and a broken result here is invalid SQL rather than bad security —
    // but it fails mid-migration, after touching some policies.
    expect(wrapIdentityCalls("public.current_app_role() = 'cpo'")).toBe(
      "(select public.current_app_role()) = 'cpo'",
    );
    expect(wrapIdentityCalls("public.current_app_role()")).not.toContain(".(select");
  });

  it("keeps row-dependent functions unwrapped", () => {
    // afterschool_owned(is_afterschool, start_at) reads the row. Wrapping it
    // would evaluate it once for the whole statement and hand every row the
    // first row's answer — a silent, total authorization failure.
    const policy = "not afterschool_owned(is_afterschool, start_at)";
    expect(wrapIdentityCalls(policy)).toBe(policy);
    expect(migration).toContain("afterschool_owned(...) and");
  });
});

describe("the invariant checks that caught it", () => {
  it("compares before and after with the wrappers stripped", () => {
    expect(migration).toContain("Invariant 2");
    expect(migration).toMatch(/is distinct from\s*\n\s*regexp_replace\(v_after/);
  });

  it("rolls back rather than reporting", () => {
    // All three invariants must RAISE. A notice would let a corrupted policy
    // set commit with a warning nobody reads.
    for (const invariant of [
      "Policy count changed from % to %. Rolling back.",
      "changed in more than its evaluation order. Rolling back.",
      "policies still call an identity function per row. Rolling back.",
    ]) {
      const at = migration.indexOf(invariant);
      expect(at, `missing invariant: ${invariant}`).toBeGreaterThan(-1);
      expect(migration.slice(Math.max(0, at - 120), at)).toContain("raise exception");
    }
  });

  it("has no narrow already-applied guard", () => {
    // The original guard asked whether any policy contained
    // 'SELECT current_app_role()' and answered "not applied" — while the one
    // policy carrying a wrapper carried it on auth.uid(). A guard that answers
    // a narrower question than it appears to is worse than none, and the wrap
    // is idempotent now, so it is gone.
    expect(migration).not.toContain("like '%SELECT current_app_role()%'");
    expect(migration).not.toContain("0083 already applied");
  });
});
