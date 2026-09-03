/**
 * Why a teacher was not there, what a manager decided actually happened, and
 * whether anyone was told in advance.
 *
 * Twins of absence_reason_label() (migration 0079), flag_outcome_label() and
 * notice_channel_label() (0080). As with flag-reasons.ts, SQL renders the
 * label that reaches the spreadsheet and this list draws the dropdown, so the
 * two halves have to stay character-identical — tests/absence-reasons.test.ts
 * checks that against the migration files.
 *
 * One list of absence reasons, shared by the Substitutions screen and the
 * missed-clock-in form, because "why was the teacher away" is one question
 * asked from two places. Two lists is how "forgot" became six spellings.
 */
export const ABSENCE_REASONS = [
  { value: "sick", label: "Sick" },
  { value: "family_emergency", label: "Family emergency" },
  { value: "personal", label: "Personal" },
  { value: "second_job", label: "Conflict with another job" },
  { value: "transport", label: "Transport / car trouble" },
  { value: "training", label: "Training or a YMU commitment" },
  { value: "school_request", label: "The school asked for a change" },
  { value: "no_reason_given", label: "No reason given" },
  { value: "other", label: "Other" },
] as const;

export type AbsenceReason = (typeof ABSENCE_REASONS)[number]["value"];

export function isAbsenceReason(value: unknown): value is AbsenceReason {
  return ABSENCE_REASONS.some((reason) => reason.value === value);
}

export function absenceReasonLabel(value: string): string | undefined {
  return ABSENCE_REASONS.find((reason) => reason.value === value)?.label;
}

/**
 * What the manager decided happened. This is the fork in the missed-clock-in
 * form: the first option is the everyday correction, the other three each
 * demand their own follow-up questions.
 */
export const FLAG_OUTCOMES = [
  { value: "attendance_corrected", label: "They were here — attendance corrected" },
  { value: "stayed_missed", label: "They were absent" },
  { value: "substitute_covered", label: "A substitute covered the class" },
  { value: "class_not_held", label: "The class did not happen" },
] as const;

export type FlagOutcome = (typeof FLAG_OUTCOMES)[number]["value"];

export function isFlagOutcome(value: unknown): value is FlagOutcome {
  return FLAG_OUTCOMES.some((outcome) => outcome.value === value);
}

/** "No notice at all" is a real answer, and the one worth counting. */
export const NOTICE_CHANNELS = [
  { value: "called", label: "Called" },
  { value: "texted", label: "Texted / WhatsApp" },
  { value: "emailed", label: "Emailed" },
  { value: "told_colleague", label: "Told a colleague or the school" },
  { value: "none", label: "No notice at all" },
] as const;

export type NoticeChannel = (typeof NOTICE_CHANNELS)[number]["value"];

export function isNoticeChannel(value: unknown): value is NoticeChannel {
  return NOTICE_CHANNELS.some((channel) => channel.value === value);
}

/** Which outcomes need to know why the teacher was away. */
export function outcomeNeedsAbsenceReason(outcome: string): boolean {
  return outcome === "stayed_missed" || outcome === "substitute_covered";
}

/** Only a genuine absence raises the notice and excusal questions. */
export function outcomeNeedsNotice(outcome: string): boolean {
  return outcome === "stayed_missed";
}

export function outcomeNeedsSubstitution(outcome: string): boolean {
  return outcome === "substitute_covered";
}

/**
 * Only "they were here" needs a clock-in time and an on-time/late answer —
 * the other three outcomes each resolve to a fixed status (absent, absent,
 * not_held) with no clock-in to speak of. 0097: this is what makes "Mark
 * resolved" a complete replacement for "Record attendance" on a late
 * clock-in flag, so there is exactly one place to answer "what happened".
 */
export function outcomeNeedsClockIn(outcome: string): boolean {
  return outcome === "attendance_corrected";
}

export type OutcomeDraft = {
  outcome: string;
  absenceReason: string;
  notifiedChannel: string;
  excused: string;
  substitutionId: string;
  clockInAt: string;
  clockInStatus: string;
};

export const EMPTY_OUTCOME_DRAFT: OutcomeDraft = {
  outcome: "",
  absenceReason: "",
  notifiedChannel: "",
  excused: "",
  substitutionId: "",
  clockInAt: "",
  clockInStatus: "",
};

/**
 * The client-side echo of resolve_flag()'s validation, so a manager hears
 * about a missing field before the round trip. SQL raises on every one of
 * these regardless.
 *
 * notified_in_advance is derived rather than asked: a channel other than
 * "none" IS notice, and asking both questions produced the one pair of
 * answers that could contradict itself.
 *
 * Returns null when the form is good to submit.
 */
export function describeOutcomeGap(draft: OutcomeDraft): string | null {
  const { outcome, absenceReason, notifiedChannel, excused, substitutionId, clockInStatus } = draft;
  if (!outcome) return null; // Optional — the everyday case leaves it unset.
  if (!isFlagOutcome(outcome)) return "Choose what happened from the list.";

  if (outcomeNeedsClockIn(outcome)) {
    // The time is a courtesy, not a requirement — a manager confirming
    // "they were here" often knows on-time-vs-late without knowing the exact
    // minute (that is usually why the flag needed a manual answer at all).
    if (clockInStatus !== "on_time" && clockInStatus !== "late") {
      return "Record whether they were on time or late.";
    }
  }

  if (outcomeNeedsAbsenceReason(outcome)) {
    if (!absenceReason) return "Choose why the teacher was away.";
    if (!isAbsenceReason(absenceReason)) return "Choose an absence reason from the list.";
  }

  if (outcomeNeedsNotice(outcome)) {
    if (!notifiedChannel) {
      return "Record how the teacher let anyone know — “No notice at all” is an answer.";
    }
    if (!isNoticeChannel(notifiedChannel)) return "Choose a notice channel from the list.";
    if (excused !== "yes" && excused !== "no") {
      return "Record whether this absence is excused.";
    }
  }

  if (outcomeNeedsSubstitution(outcome) && !substitutionId) {
    return "Pick the substitution that covered this class, or record one first.";
  }

  return null;
}

/** What resolve_flag() wants, built from the form's own shape. */
export function toOutcomePayload(draft: OutcomeDraft) {
  const { outcome } = draft;
  if (!outcome) {
    return {
      p_outcome: null,
      p_absence_reason: null,
      p_notified_in_advance: null,
      p_notified_channel: null,
      p_excused: null,
      p_substitution_id: null,
      p_clock_in_at: null,
      p_clock_in_status: null,
    };
  }
  const notice = outcomeNeedsNotice(outcome);
  const needsClockIn = outcomeNeedsClockIn(outcome);
  return {
    p_outcome: outcome,
    p_absence_reason: outcomeNeedsAbsenceReason(outcome) ? draft.absenceReason : null,
    p_notified_in_advance: notice ? draft.notifiedChannel !== "none" : null,
    p_notified_channel: notice ? draft.notifiedChannel : null,
    p_excused: notice ? draft.excused === "yes" : null,
    p_substitution_id: outcomeNeedsSubstitution(outcome) ? draft.substitutionId : null,
    p_clock_in_at: needsClockIn && draft.clockInAt ? new Date(draft.clockInAt).toISOString() : null,
    p_clock_in_status: needsClockIn ? draft.clockInStatus : null,
  };
}
