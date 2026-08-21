"use client";

import { useActionState, useState } from "react";
import { resolveFlag, type ResolveFlagState } from "./actions";
import ReasonPicker from "./reason-picker";

const initialState: ResolveFlagState = undefined;

/**
 * Two steps now, where it used to be one click.
 *
 * That is a deliberate cost. "Mark resolved" with no reason is how 44 of the
 * first 93 resolved flags ended up with nothing on record — the fastest path
 * through the screen was also the one that destroyed the information. Asking
 * for the cause is one dropdown, and it is the only thing that makes the
 * Flags tab answer "how much of this is our app failing".
 *
 * The disclosure pattern (closed button → inline form) is the same one
 * AdminEditAttendanceForm uses, so a manager working down the page sees one
 * shape, not two.
 */
export default function ResolveFlagButton({ flagId }: { flagId: string }) {
  const [state, formAction, pending] = useActionState(resolveFlag, initialState);
  const [open, setOpen] = useState(false);

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

      <div className="mt-1 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
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

      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
