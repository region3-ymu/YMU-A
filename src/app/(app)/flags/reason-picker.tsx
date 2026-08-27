"use client";

import { useState } from "react";
import { FLAG_REASONS, REASON_REQUIRING_NOTES, describeReasonGap } from "@/lib/attendance/flag-reasons";

/**
 * The reason dropdown, shared by every place a manager closes a late clock-in:
 * the resolve button and both halves of the attendance form.
 *
 * It used to be one free-text box per form, which is how "Forgot to do it",
 * "Forgot", "Forgot it", "Forgot tondonit" and "Present but forgot to clock
 * in" all came to mean the same thing in the spreadsheet.
 *
 * Uncontrolled by design — the parent forms all dispatch a server action with
 * FormData and hold no state of their own, so the only local state here is
 * what the notes field needs to know: which reason is selected.
 *
 * The notes box is always available (a manager who wants to add detail to
 * "Tech problem" should), and only mandatory for "Other". `gap` is a courtesy
 * echo of flag_resolution_note()'s two raise conditions; SQL enforces them
 * whatever this renders.
 */
export default function ReasonPicker({
  autoFocus = false,
  notesPlaceholder = "Anything worth knowing later (optional)",
  onReasonChange,
}: {
  autoFocus?: boolean;
  notesPlaceholder?: string;
  /** Lets the parent react to the choice — the attendance form uses it to drop
   *  the on-time/late question when the class did not happen. */
  onReasonChange?: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const notesRequired = reason === REASON_REQUIRING_NOTES;
  const gap = describeReasonGap(reason, notes);

  return (
    <>
      <label className="text-xs font-medium text-on-surface-variant">
        Reason (required)
        <select
          name="reason"
          required
          autoFocus={autoFocus}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            onReasonChange?.(event.target.value);
          }}
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="" disabled>
            Choose a reason…
          </option>
          {FLAG_REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-on-surface-variant">
        {notesRequired ? "What happened (required)" : "Notes (optional)"}
        <textarea
          name="reason_notes"
          rows={2}
          required={notesRequired}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={notesRequired ? "Describe what happened" : notesPlaceholder}
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      {/* Only once the manager has started — an empty form does not need
          telling that it is empty. */}
      {reason !== "" && gap && <p className="text-xs text-error">{gap}</p>}
    </>
  );
}
