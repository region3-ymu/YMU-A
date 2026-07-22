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
        className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
      >
        {pending ? "Archiving…" : "Archive"}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
