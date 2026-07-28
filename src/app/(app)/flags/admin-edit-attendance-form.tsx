"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { editAttendanceAction, createAttendanceAction } from "./admin-edit-actions";

// Either edit an existing session (sessionId set) or record one that never
// happened (eventId/teacherId set, no session exists yet). Requires the
// caller to re-enter their OWN password immediately before submitting — a
// fresh supabase.auth.signInWithPassword() call, done here client-side
// because it needs the caller's live email + a password they just typed;
// the server actions trust this happened and re-check role/region only
// (the same authorization split every other manager action here uses).
export default function AdminEditAttendanceForm({
  callerEmail,
  sessionId,
  eventId,
  teacherId,
  scheduledStartAt,
  currentStatus,
  currentClockInAt,
}: {
  callerEmail: string;
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
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError(null);
    if (!password) {
      setAuthError("Enter your password to confirm this change.");
      return;
    }

    setVerifying(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: callerEmail, password });
    setVerifying(false);

    if (error) {
      setAuthError("Incorrect password.");
      return;
    }

    dispatch(new FormData(event.currentTarget));
  }

  return (
    <form
      onSubmit={handleSubmit}
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

      <label className="text-xs font-medium text-on-surface-variant">
        Your password (to confirm this change)
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <div className="mt-1 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || verifying}
          className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {verifying ? "Verifying…" : pending ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface"
        >
          Cancel
        </button>
      </div>

      {authError && (
        <p role="alert" className="text-xs text-error">
          {authError}
        </p>
      )}
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
