// Guards on migration 0085, which fixed a defect that locked a real teacher out
// of clocking in.
//
// Pedro Diaz recorded Cristian Perez's class as `class_not_held` a day and a
// half after it ended. admin_create_attendance computed
// feedback_due_at = end_at + 24 hours = two hours BEFORE the row existed, so the
// session was born overdue — and clock_in() refuses anyone with overdue
// feedback. Correcting a teacher's attendance locked him out, and the form it
// demanded was a lesson reflection for a class that did not happen.
//
// Both halves were verified against production inside rolled-back transactions:
// a class from 31 July recorded as `forgot` now gets a deadline 24 hours out
// rather than 26 days in the past, and `class_not_held` gets no deadline at all.
// What these tests hold is the shape, so neither half can be quietly undone.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLAG_REASONS } from "../src/lib/attendance/flag-reasons";

const MIGRATION = "supabase/migrations/0085_backdated_entry_and_class_not_held.sql";
const sql = readFileSync(MIGRATION, "utf8");

/** The body of one function in the migration, so assertions cannot cross over. */
function bodyOf(fn: string): string {
  const start = sql.indexOf(`create or replace function public.${fn}(`);
  expect(start, `${fn} not found in ${MIGRATION}`).toBeGreaterThan(-1);
  const end = sql.indexOf("comment on function", start);
  return sql.slice(start, end === -1 ? undefined : end);
}

describe("the back-dated deadline floor", () => {
  const create = bodyOf("admin_create_attendance");

  it("floors the feedback deadline at 24 hours from now", () => {
    // The whole bug in one expression. Without greatest(), a class recorded a
    // day late produces a deadline that has already passed.
    expect(create).toContain("greatest(v_event.end_at + interval '24 hours', now() + interval '24 hours')");
  });

  it("never writes the bare end_at + 24 hours again", () => {
    // The exact expression that shipped the bug, in the exact place it shipped.
    expect(create).not.toMatch(/feedback_due_at[^;]*\bv_event\.end_at \+ interval '24 hours'\s*(end)?,?\s*$/m);
  });

  // Deliberately NOT applied to admin_edit_attendance: it has never set
  // feedback_due_at, so it cannot create an expired demand, and giving it the
  // power to rewrite a deadline would be new behaviour nobody asked for.
  it("is not added to admin_edit_attendance", () => {
    expect(bodyOf("admin_edit_attendance")).not.toContain("greatest(");
  });
});

describe("class_not_held owes no feedback", () => {
  it("is a real reason code, so the check has something to match", () => {
    // If the code were ever renamed, both functions would silently stop
    // recognising it and quietly start demanding forms again.
    expect(FLAG_REASONS.map((r) => r.value)).toContain("class_not_held");
  });

  it.each(["admin_create_attendance", "admin_edit_attendance"])(
    "%s recognises it",
    (fn) => {
      expect(bodyOf(fn)).toContain("v_no_feedback boolean := p_reason = 'class_not_held'");
    },
  );

  it.each(["admin_create_attendance", "admin_edit_attendance"])(
    "%s sets BOTH halves of the settled marker",
    (fn) => {
      // has_overdue_feedback() reads `feedback_settled_at is null AND
      // feedback_due_at is not null`, so clearing only one leaves the session
      // still counted. This is the pair migration 0081 established.
      const body = bodyOf(fn);
      expect(body).toContain("v_no_feedback");
      expect(body).toMatch(/feedback_settled_at/);
      expect(body).toMatch(/feedback_due_at/);
    },
  );

  it("leaves the deadline alone for every other reason on edit", () => {
    // Case A of the production rehearsal: reason=forgot on an existing session
    // left the deadline at 08-27 10:30, untouched.
    expect(bodyOf("admin_edit_attendance")).toContain(
      "feedback_due_at     = case when v_no_feedback then null else feedback_due_at end",
    );
  });
});

describe("the one-off backfill", () => {
  const backfill = sql.slice(sql.lastIndexOf("update public.attendance_sessions a"));

  it("only touches sessions that were born overdue", () => {
    // `feedback_due_at < a.created_at` is the narrow condition: the demand had
    // already expired when the row was written. A session that simply went
    // overdue later is a teacher who owes real feedback and must stay owing it.
    expect(backfill).toContain("a.feedback_due_at < a.created_at");
    expect(backfill).not.toContain("a.feedback_due_at < now()");
  });

  it("never discards feedback somebody actually submitted", () => {
    for (const guard of [
      "a.feedback_submitted_at is null",
      "a.relay_feedback_submitted_at is null",
      "from public.feedback_submissions f where f.session_id = a.id",
    ]) {
      expect(backfill).toContain(guard);
    }
  });

  it("preserves an existing settled stamp rather than overwriting it", () => {
    expect(backfill).toContain("coalesce(a.feedback_settled_at, now())");
  });
});
