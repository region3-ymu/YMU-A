"use client";

import { useActionState } from "react";
import { resolveFlag, type ResolveFlagState } from "./actions";

const initialState: ResolveFlagState = undefined;

export default function ResolveFlagButton({ flagId }: { flagId: string }) {
  const [state, formAction, pending] = useActionState(resolveFlag, initialState);

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="flag_id" value={flagId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-full border-2 border-outline px-5 py-2.5 text-sm font-bold text-on-surface transition-transform active:scale-[0.98] disabled:opacity-50"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          check
        </span>
        {pending ? "Resolving…" : "Mark resolved"}
      </button>
      {state?.error && <p className="mt-1 text-sm text-error">{state.error}</p>}
    </form>
  );
}
