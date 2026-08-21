// Three lists live in both SQL and TypeScript, for the reason flag-reasons.ts
// gives: SQL renders the label that reaches the spreadsheet, TS draws the
// dropdown. The parity tests are what make that duplication safe.
//
// The rest of this file pins resolve_flag()'s validation rules from the
// client's side. They are enforced in SQL regardless; what these guard is that
// the form does not offer a combination the server will refuse, which is the
// difference between a helpful message and a raw Postgres exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABSENCE_REASONS,
  EMPTY_OUTCOME_DRAFT,
  FLAG_OUTCOMES,
  NOTICE_CHANNELS,
  describeOutcomeGap,
  isAbsenceReason,
  isFlagOutcome,
  isNoticeChannel,
  outcomeNeedsAbsenceReason,
  outcomeNeedsNotice,
  outcomeNeedsSubstitution,
  toOutcomePayload,
  type OutcomeDraft,
} from "../src/lib/attendance/absence-reasons";

function labelsFrom(path: string, functionName: string): { value: string; label: string }[] {
  const sql = readFileSync(path, "utf8");
  const body = sql.slice(sql.indexOf(`function public.${functionName}(`));
  const caseExpression = body.slice(0, body.indexOf("$$;"));
  return [...caseExpression.matchAll(/when '([a-z_]+)'\s+then '(.+?)'$/gm)].map(
    ([, value, label]) => ({ value, label }),
  );
}

describe("the SQL twins", () => {
  it.each([
    ["absence reasons", "supabase/migrations/0079_substitutions.sql", "absence_reason_label", ABSENCE_REASONS],
    ["flag outcomes", "supabase/migrations/0080_missed_clock_in_detail.sql", "flag_outcome_label", FLAG_OUTCOMES],
    ["notice channels", "supabase/migrations/0080_missed_clock_in_detail.sql", "notice_channel_label", NOTICE_CHANNELS],
  ] as const)("%s match, code for code and label for label", (_name, path, fn, list) => {
    expect(labelsFrom(path, fn)).toEqual(list.map((entry) => ({ ...entry })));
  });

  it("keeps the absence reasons in step with the table's CHECK constraint", () => {
    // substitutions_reason_known duplicates the list deliberately (a CHECK
    // that calls a function ties table validity to dump ordering), which makes
    // it a third copy to keep honest.
    const sql = readFileSync("supabase/migrations/0079_substitutions.sql", "utf8");
    const constraint = sql.slice(
      sql.indexOf("constraint substitutions_reason_known"),
      sql.indexOf("-- Covering yourself"),
    );
    for (const reason of ABSENCE_REASONS) {
      expect(constraint).toContain(`'${reason.value}'`);
    }
  });
});

describe("the guards", () => {
  it("accept every code on their own list and nothing else", () => {
    expect(ABSENCE_REASONS.every((r) => isAbsenceReason(r.value))).toBe(true);
    expect(FLAG_OUTCOMES.every((o) => isFlagOutcome(o.value))).toBe(true);
    expect(NOTICE_CHANNELS.every((c) => isNoticeChannel(c.value))).toBe(true);

    expect(isAbsenceReason("stayed_missed")).toBe(false);
    expect(isFlagOutcome("sick")).toBe(false);
    expect(isNoticeChannel("called_them")).toBe(false);
    expect(isNoticeChannel(null)).toBe(false);
  });

  // "No notice at all" has to be a selectable answer, not the absence of one.
  // An empty channel means the manager has not answered; 'none' means they
  // have, and it is the value worth counting.
  it("treats no notice as an answer", () => {
    expect(isNoticeChannel("none")).toBe(true);
  });
});

describe("which outcome asks what", () => {
  it("asks why they were away only when they were away", () => {
    expect(outcomeNeedsAbsenceReason("stayed_missed")).toBe(true);
    expect(outcomeNeedsAbsenceReason("substitute_covered")).toBe(true);
    expect(outcomeNeedsAbsenceReason("attendance_corrected")).toBe(false);
    expect(outcomeNeedsAbsenceReason("class_not_held")).toBe(false);
  });

  it("asks about notice and excusal only for a genuine absence", () => {
    // Not for substitute_covered: cover was arranged, so the question of
    // whether an absence is excused is a different conversation.
    expect(FLAG_OUTCOMES.filter((o) => outcomeNeedsNotice(o.value)).map((o) => o.value)).toEqual([
      "stayed_missed",
    ]);
  });

  it("asks who covered it only when someone did", () => {
    expect(
      FLAG_OUTCOMES.filter((o) => outcomeNeedsSubstitution(o.value)).map((o) => o.value),
    ).toEqual(["substitute_covered"]);
  });
});

describe("describeOutcomeGap", () => {
  const draft = (over: Partial<OutcomeDraft> = {}): OutcomeDraft => ({
    ...EMPTY_OUTCOME_DRAFT,
    ...over,
  });

  it("passes an unset outcome — it is optional", () => {
    expect(describeOutcomeGap(draft())).toBeNull();
  });

  it("passes the everyday correction with nothing else", () => {
    expect(describeOutcomeGap(draft({ outcome: "attendance_corrected" }))).toBeNull();
    expect(describeOutcomeGap(draft({ outcome: "class_not_held" }))).toBeNull();
  });

  it("rejects an outcome that is not on the list", () => {
    expect(describeOutcomeGap(draft({ outcome: "they_were_late" }))).toContain("from the list");
  });

  // The gap this whole migration exists to close: "they were absent" with
  // nothing else recorded.
  it("will not let an absence stand alone", () => {
    expect(describeOutcomeGap(draft({ outcome: "stayed_missed" }))).toContain("why the teacher was away");
    expect(
      describeOutcomeGap(draft({ outcome: "stayed_missed", absenceReason: "sick" })),
    ).toContain("let anyone know");
    expect(
      describeOutcomeGap(
        draft({ outcome: "stayed_missed", absenceReason: "sick", notifiedChannel: "called" }),
      ),
    ).toContain("excused");
  });

  it("passes a fully answered absence", () => {
    expect(
      describeOutcomeGap(
        draft({
          outcome: "stayed_missed",
          absenceReason: "sick",
          notifiedChannel: "called",
          excused: "yes",
        }),
      ),
    ).toBeNull();
  });

  it("passes an unexcused no-notice absence", () => {
    expect(
      describeOutcomeGap(
        draft({
          outcome: "stayed_missed",
          absenceReason: "no_reason_given",
          notifiedChannel: "none",
          excused: "no",
        }),
      ),
    ).toBeNull();
  });

  it("demands a real substitution rather than a name", () => {
    expect(
      describeOutcomeGap(draft({ outcome: "substitute_covered", absenceReason: "sick" })),
    ).toContain("substitution");
    expect(
      describeOutcomeGap(
        draft({ outcome: "substitute_covered", absenceReason: "sick", substitutionId: "abc" }),
      ),
    ).toBeNull();
  });
});

describe("toOutcomePayload", () => {
  it("sends nothing at all when no outcome was chosen", () => {
    const payload = toOutcomePayload(EMPTY_OUTCOME_DRAFT);
    expect(Object.values(payload).every((value) => value === null)).toBe(true);
  });

  // resolve_flag REFUSES a field its outcome does not imply, so forwarding
  // whatever the form was holding would turn a stale selection into a raw
  // exception. Nulling here is what makes the reset-on-change in the UI a
  // convenience rather than a correctness requirement.
  it("drops the fields the outcome does not imply", () => {
    const payload = toOutcomePayload({
      outcome: "attendance_corrected",
      absenceReason: "sick",
      notifiedChannel: "called",
      excused: "yes",
      substitutionId: "abc",
    });
    expect(payload).toEqual({
      p_outcome: "attendance_corrected",
      p_absence_reason: null,
      p_notified_in_advance: null,
      p_notified_channel: null,
      p_excused: null,
      p_substitution_id: null,
    });
  });

  // notified_in_advance is derived, never asked. Asking both questions was the
  // one pair of answers a manager could make contradict each other, and SQL
  // raises on exactly that contradiction.
  it("derives notified_in_advance from the channel", () => {
    const notified = toOutcomePayload({
      outcome: "stayed_missed",
      absenceReason: "sick",
      notifiedChannel: "texted",
      excused: "yes",
      substitutionId: "",
    });
    expect(notified.p_notified_in_advance).toBe(true);
    expect(notified.p_excused).toBe(true);

    const silent = toOutcomePayload({
      outcome: "stayed_missed",
      absenceReason: "no_reason_given",
      notifiedChannel: "none",
      excused: "no",
      substitutionId: "",
    });
    expect(silent.p_notified_in_advance).toBe(false);
    expect(silent.p_excused).toBe(false);
  });

  it("cannot produce the pair SQL rejects", () => {
    // "They gave notice" plus "no notice at all" is the contradiction
    // resolve_flag raises on. Derivation makes it unreachable.
    for (const channel of NOTICE_CHANNELS) {
      const payload = toOutcomePayload({
        outcome: "stayed_missed",
        absenceReason: "sick",
        notifiedChannel: channel.value,
        excused: "yes",
        substitutionId: "",
      });
      expect(payload.p_notified_in_advance).toBe(channel.value !== "none");
    }
  });
});
