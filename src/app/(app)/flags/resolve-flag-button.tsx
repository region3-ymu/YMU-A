"use client";

import { useActionState, useState } from "react";
import {
  ABSENCE_REASONS,
  FLAG_OUTCOMES,
  NOTICE_CHANNELS,
  describeOutcomeGap,
  outcomeNeedsAbsenceReason,
  outcomeNeedsClockIn,
  outcomeNeedsNotice,
  outcomeNeedsSubstitution,
  EMPTY_OUTCOME_DRAFT,
  type OutcomeDraft,
} from "@/lib/attendance/absence-reasons";
import { resolveFlag, type ResolveFlagState } from "./actions";
import ReasonPicker from "./reason-picker";

const initialState: ResolveFlagState = undefined;

/**
 * Two steps now, where it used to be one click.
 *
 * That is a deliberate cost. "Mark resolved" with no reason is how 44 of the
 * first 93 resolved flags ended up with nothing on record — the fastest path
 * through the screen was also the one that destroyed the information.
 *
 * On a late clock-in it asks one more thing: what actually happened. Only that
 * flag type gets it, because only there is "the teacher was absent" a possible
 * answer, and only there does the answer have consequences — payroll, the
 * school's relationship, and whether it is a pattern.
 *
 * The follow-up questions appear per outcome rather than all at once. A
 * manager correcting attendance for someone who was demonstrably there should
 * not be shown a box asking whether their absence is excused.
 */
export default function ResolveFlagButton({
  flagId,
  askOutcome = false,
  cover = [],
}: {
  flagId: string;
  askOutcome?: boolean;
  /** Confirmed substitutions for this exact class and teacher. */
  cover?: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(resolveFlag, initialState);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OutcomeDraft>(EMPTY_OUTCOME_DRAFT);

  const set = <K extends keyof OutcomeDraft>(key: K, value: OutcomeDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const gap = describeOutcomeGap(draft);
  const { outcome } = draft;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full border-2 border-outline px-5 py-2.5 text-sm font-bold text-on-surface transition-transform active:scale-[0.98]"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          check
        </span>
        Mark resolved
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="mt-3 flex flex-col gap-2 rounded-lg bg-surface-container-low p-3"
    >
      <input type="hidden" name="flag_id" value={flagId} />

      <ReasonPicker autoFocus />

      {askOutcome && (
        <>
          <label className="text-xs font-medium text-on-surface-variant">
            What actually happened (optional)
            <select
              name="outcome"
              value={outcome}
              onChange={(event) => {
                // Reset the dependants, not just the outcome. resolve_flag
                // REFUSES a field the outcome does not imply — an absence
                // reason left behind from a previous selection would be
                // rejected as "does not apply when the teacher was here",
                // which reads as a bug rather than a stale form.
                setDraft({ ...EMPTY_OUTCOME_DRAFT, outcome: event.target.value });
              }}
              className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Not recording this</option>
              {FLAG_OUTCOMES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {outcomeNeedsClockIn(outcome) && (
            <>
              <label className="text-xs font-medium text-on-surface-variant">
                When they actually clocked in (optional)
                <input
                  type="datetime-local"
                  name="clock_in_at"
                  value={draft.clockInAt}
                  onChange={(event) => set("clockInAt", event.target.value)}
                  className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                />
              </label>
              <p className="text-xs text-on-surface-variant">
                Leave blank if nobody knows the exact minute — on time or late below is what
                actually matters.
              </p>
              <label className="text-xs font-medium text-on-surface-variant">
                Status (required)
                <select
                  name="clock_in_status"
                  required
                  value={draft.clockInStatus}
                  onChange={(event) => set("clockInStatus", event.target.value)}
                  className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="on_time">On time</option>
                  <option value="late">Late</option>
                </select>
              </label>
            </>
          )}

          {outcomeNeedsAbsenceReason(outcome) && (
            <label className="text-xs font-medium text-on-surface-variant">
              Why they were away (required)
              <select
                name="absence_reason"
                required
                value={draft.absenceReason}
                onChange={(event) => set("absenceReason", event.target.value)}
                className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="" disabled>
                  Choose a reason…
                </option>
                {ABSENCE_REASONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {outcomeNeedsNotice(outcome) && (
            <>
              <label className="text-xs font-medium text-on-surface-variant">
                Did they let anyone know? (required)
                <select
                  name="notified_channel"
                  required
                  value={draft.notifiedChannel}
                  onChange={(event) => set("notifiedChannel", event.target.value)}
                  className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="" disabled>
                    Choose how…
                  </option>
                  {NOTICE_CHANNELS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* Radios, not a checkbox. An unticked box means "not excused"
                  and "nobody answered yet" at the same time, and this is the
                  field payroll will filter on. */}
              <fieldset className="text-xs font-medium text-on-surface-variant">
                <legend>Is this absence excused? (required)</legend>
                <div className="mt-1 flex gap-4">
                  {(["yes", "no"] as const).map((value) => (
                    <label key={value} className="flex items-center gap-1.5 text-on-surface">
                      <input
                        type="radio"
                        name="excused"
                        value={value}
                        required
                        checked={draft.excused === value}
                        onChange={() => set("excused", value)}
                        className="size-4 accent-primary"
                      />
                      {value === "yes" ? "Excused" : "Not excused"}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}

          {outcomeNeedsSubstitution(outcome) &&
            (cover.length > 0 ? (
              <label className="text-xs font-medium text-on-surface-variant">
                Who covered it (required)
                <select
                  name="substitution_id"
                  required
                  value={draft.substitutionId}
                  onChange={(event) => set("substitutionId", event.target.value)}
                  className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="" disabled>
                    Choose the substitution…
                  </option>
                  {cover.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              // Deliberately a dead end rather than a free-text box. A typed
              // name is what this whole change replaces: "Confirmed DeAnthony
              // as the substitute for this class" joins to nothing.
              <p className="rounded-lg bg-warning-container p-2 text-xs text-on-warning-container">
                No cover is recorded for this class yet. Record it on{" "}
                <a href="/substitutes" className="font-bold underline">
                  Substitutes
                </a>{" "}
                first, then come back — that way the class, the absence and who taught it are one
                record instead of a note.
              </p>
            ))}
        </>
      )}

      <div className="mt-1 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || gap !== null}
          className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Resolving…" : "Resolve"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface"
        >
          Cancel
        </button>
      </div>

      {gap && <p className="text-xs text-error">{gap}</p>}
      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
