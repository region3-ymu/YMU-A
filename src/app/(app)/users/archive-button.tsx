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
        className={`rounded-full px-4 py-1.5 text-sm font-bold active:scale-[0.98] disabled:opacity-40 ${
          archived
            ? "border-2 border-outline text-on-surface"
            : "bg-error-container text-on-error-container shadow-sm"
        }`}
      >
        {pending ? "Saving…" : archived ? "Unarchive" : "Archive"}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="text-xs text-tertiary">{state.success}</p>
      )}
    </form>
  );
}
