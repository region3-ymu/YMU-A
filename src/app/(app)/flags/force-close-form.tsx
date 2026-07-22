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
        className="mt-3 rounded-lg border border-red-500/40 px-3 py-1.5 text-sm font-semibold text-red-600 dark:text-red-400"
      >
        Force close session
      </button>
    );
  }

  return (
    <form action={action} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="session_id" value={sessionId} />
      <label htmlFor={`reason-${sessionId}`} className="text-xs font-medium">
        Reason (required)
      </label>
      <textarea
        id={`reason-${sessionId}`}
        name="reason"
        required
        rows={2}
        placeholder="e.g. confirmed by phone the class happened, teacher can't reach the Zoho form"
        className="rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-red-500"
        >
          {pending ? "Closing…" : "Confirm force close"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
      </div>
      {state?.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
