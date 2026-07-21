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
        className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
      >
        {pending ? "Resolving…" : "Mark resolved"}
      </button>
      {state?.error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
