"use client";

import { useActionState } from "react";
import { clockOut, type ClockOutState } from "./actions";

// Ending a class is its own action now, separate from feedback (migration
// 0026). Deliberately not a confirm dialog: clocking out is idempotent and
// trivially undone by clocking back in, and a teacher packing up between
// classes does not need a modal.
export default function ClockOutButton({ sessionId }: { sessionId: string }) {
  const [state, formAction, pending] = useActionState<ClockOutState, FormData>(clockOut, undefined);

  return (
    <form action={formAction}>
      <input type="hidden" name="session_id" value={sessionId} />
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 font-semibold text-on-primary shadow-sm transition hover:opacity-90 disabled:opacity-60"
      >
        <span className="material-symbols-outlined" aria-hidden>logout</span>
        {pending ? "Clocking out…" : "Clock out"}
      </button>
      {state?.error && (
        <p className="mt-2 rounded-lg bg-error-container p-3 text-sm text-on-error-container">
          {state.error}
        </p>
      )}
    </form>
  );
}
