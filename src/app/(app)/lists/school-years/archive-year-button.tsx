"use client";

import { useActionState } from "react";
import { archiveSchoolYear } from "./actions";

export default function ArchiveYearButton({ yearId }: { yearId: string }) {
  const [state, action, pending] = useActionState(archiveSchoolYear, undefined);

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="year_id" value={yearId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-full border-2 border-outline px-4 py-1.5 text-sm font-bold text-on-surface active:scale-[0.98] disabled:opacity-50"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          inventory_2
        </span>
        {pending ? "Archiving…" : "Archive"}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
