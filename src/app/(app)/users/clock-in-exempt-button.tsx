"use client";

import { useActionState } from "react";
import { setClockInExempt } from "./actions";

// Only rendered for teachers — nobody else clocks in, so the control would be
// meaningless on a manager's row.
export default function ClockInExemptButton({
  targetId,
  exempt,
}: {
  targetId: string;
  exempt: boolean;
}) {
  const [state, action, pending] = useActionState(setClockInExempt, undefined);

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="target_id" value={targetId} />
      <input type="hidden" name="exempt" value={exempt ? "no" : "yes"} />
      <button
        type="submit"
        disabled={pending}
        title={
          exempt
            ? "Put this teacher back on the normal clock-in flow"
            : "Record this teacher's attendance automatically instead of asking them to clock in"
        }
        className={`rounded-full px-4 py-1.5 text-sm font-bold active:scale-[0.98] disabled:opacity-40 ${
          exempt
            ? "bg-tertiary-container text-on-tertiary-container shadow-sm"
            : "border-2 border-outline text-on-surface"
        }`}
      >
        {pending ? "Saving…" : exempt ? "Auto-attendance on" : "Excuse from clocking"}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
      {state?.success && <p className="max-w-56 text-right text-xs text-tertiary">{state.success}</p>}
    </form>
  );
}
