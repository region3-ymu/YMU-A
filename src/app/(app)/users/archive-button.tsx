"use client";

import { useActionState } from "react";
import { archiveTeacher, unarchiveTeacher } from "./actions";

export default function ArchiveButton({
  targetId,
  archived,
}: {
  targetId: string;
  archived: boolean;
}) {
  const [state, action, pending] = useActionState(
    archived ? unarchiveTeacher : archiveTeacher,
    undefined,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="target_id" value={targetId} />
      <button
        type="submit"
        disabled={pending}
        className={`rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${
          archived
            ? "border-foreground/20"
            : "border-red-500/40 text-red-600 dark:text-red-400"
        }`}
      >
        {pending ? "Saving…" : archived ? "Unarchive" : "Archive"}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="text-xs text-green-700 dark:text-green-300">{state.success}</p>
      )}
    </form>
  );
}
