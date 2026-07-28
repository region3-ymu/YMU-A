"use client";

import { useActionState, useState } from "react";
import { forceCloseStuckSession } from "./actions";

export default function ForceCloseForm({ sessionId }: { sessionId: string }) {
  const [state, action, pending] = useActionState(forceCloseStuckSession, undefined);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full border-2 border-error px-5 py-2.5 text-sm font-bold text-error transition-transform active:scale-[0.98]"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          lock
        </span>
        Force close session
      </button>
    );
  }

  return (
    <form action={action} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="session_id" value={sessionId} />
      <label htmlFor={`reason-${sessionId}`} className="text-xs font-medium text-on-surface-variant">
        Reason (required)
      </label>
      <textarea
        id={`reason-${sessionId}`}
        name="reason"
        required
        rows={2}
        placeholder="e.g. confirmed by phone the class happened, teacher can't reach the Zoho form"
        className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-error px-5 py-2.5 text-sm font-bold text-on-error shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Closing…" : "Confirm force close"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border-2 border-outline px-5 py-2.5 text-sm font-bold text-on-surface"
        >
          Cancel
        </button>
      </div>
      {state?.error && (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
