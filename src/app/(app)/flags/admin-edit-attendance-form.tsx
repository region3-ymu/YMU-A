"use client";

import { useActionState, useState } from "react";
import { editAttendanceAction, createAttendanceAction } from "./admin-edit-actions";

// Either edit an existing session (sessionId set) or record one that never
// happened (eventId/teacherId set, no session exists yet).
//
// No password re-entry. It used to ask for one — a fresh
// signInWithPassword() before dispatch — on the theory that rewriting
// attendance deserved a second "are you really you". YMU asked for it gone
// (2026-08-18): a manager reconciling a paper sign-in sheet does this many
// times in a sitting, and typing a password each time was the slowest part
// of the job.
//
// Nothing about accountability moved. It never lived here: admin_edit_attendance
// and admin_create_attendance (migration 0023) stamp admin_edited_by from
// auth.uid() and REJECT a blank admin_edit_reason, so every correction still
// names who made it and why. The server actions re-check role and region
// regardless of what this form allows.
export default function AdminEditAttendanceForm({
  sessionId,
  eventId,
  teacherId,
  scheduledStartAt,
  currentStatus,
  currentClockInAt,
}: {
  sessionId?: string;
  eventId?: string;
  teacherId?: string;
  scheduledStartAt?: string | null;
  currentStatus?: "on_time" | "late";
  currentClockInAt?: string | null;
}) {
  const isCreate = !sessionId;
  const action = isCreate ? createAttendanceAction : editAttendanceAction;
  const [state, dispatch, pending] = useActionState(action, undefined);
  const [open, setOpen] = useState(false);

  const defaultClockInAt = toLocalInputValue(currentClockInAt ?? scheduledStartAt ?? new Date().toISOString());

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface transition-transform active:scale-[0.98]"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          edit
        </span>
        {isCreate ? "Record attendance" : "Edit attendance"}
      </button>
    );
  }

  return (
    // Dispatched straight to the action now. The old onSubmit handler had to
    // read FormData before awaiting the password check, because React nulls
    // event.currentTarget once the handler yields; with no await there is no
    // handler left to get that wrong.
    <form
      action={dispatch}
      className="mt-2 flex flex-col gap-2 rounded-lg bg-surface-container-low p-3"
    >
      {isCreate ? (
        <>
          <input type="hidden" name="event_id" value={eventId} />
          <input type="hidden" name="teacher_id" value={teacherId} />
        </>
      ) : (
        <input type="hidden" name="session_id" value={sessionId} />
      )}

      <label className="text-xs font-medium text-on-surface-variant">
        Clock-in time
        <input
          type="datetime-local"
          name="clock_in_at"
          defaultValue={defaultClockInAt}
          required={isCreate}
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <label className="text-xs font-medium text-on-surface-variant">
        Status
        <select
          name="clock_in_status"
          defaultValue={currentStatus ?? "on_time"}
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="on_time">On time</option>
          <option value="late">Late</option>
        </select>
      </label>

      {/* The one remaining gate, and the only one that ever produced a record
          worth reading later: 0023 raises if it arrives blank. */}
      <label className="text-xs font-medium text-on-surface-variant">
        Reason (required)
        <textarea
          name="reason"
          required
          rows={2}
          placeholder="e.g. confirmed on the paper sign-in sheet"
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <div className="mt-1 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface"
        >
          Cancel
        </button>
      </div>

      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="text-xs text-tertiary">Saved.</p>
      )}
    </form>
  );
}

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in the viewer's local time.
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
