"use client";

import { useActionState, useState } from "react";
import { REGION_LABELS, type Region } from "@/lib/auth/roles";
import { cancelSubstitution } from "./actions";
import type { ConfirmResult, Substitution } from "./types";

const initialState: ConfirmResult = undefined;
const TIME_ZONE = "America/New_York";

/**
 * Cover already arranged, so the module answers "who is teaching this" as well
 * as "who could".
 *
 * The calendar chip is load-bearing, not decoration. A substitution recorded
 * here and never mirrored into the Google event means the substitute is not on
 * calendar_events.teacher_ids, so clock_in() will refuse them — the row would
 * look complete while the actual class stayed broken. Showing the gap is the
 * point until the service account has write access.
 */
export default function RecentSubstitutions({
  substitutions,
}: {
  substitutions: Substitution[];
}) {
  const [showCancelled, setShowCancelled] = useState(false);
  const shown = substitutions.filter((sub) => showCancelled || sub.status === "confirmed");
  const cancelledCount = substitutions.filter((sub) => sub.status === "cancelled").length;

  if (substitutions.length === 0) {
    return (
      <section className="rounded-2xl bg-surface-container p-4 shadow-sm">
        <h2 className="flex items-center gap-2 font-semibold text-on-surface">
          <span className="material-symbols-outlined" aria-hidden>
            history
          </span>
          Cover arranged
        </h2>
        <p className="mt-1 text-sm text-on-surface-variant">
          Nothing recorded yet. Confirming a substitute above puts it here, and on the
          Substitutions tab of the reporting spreadsheet.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-on-surface">
          <span className="material-symbols-outlined" aria-hidden>
            history
          </span>
          Cover arranged
        </h2>
        {cancelledCount > 0 && (
          <label className="flex items-center gap-2 text-xs font-medium text-on-surface">
            <input
              type="checkbox"
              checked={showCancelled}
              onChange={(event) => setShowCancelled(event.target.checked)}
              className="size-4 accent-primary"
            />
            Show {cancelledCount} cancelled
          </label>
        )}
      </div>

      <div className="mt-3 grid gap-3">
        {shown.map((sub) => (
          <Row key={sub.id} sub={sub} />
        ))}
      </div>
    </section>
  );
}

function Row({ sub }: { sub: Substitution }) {
  const [state, formAction, pending] = useActionState(cancelSubstitution, initialState);
  const [open, setOpen] = useState(false);
  const cancelled = sub.status === "cancelled";

  const when = new Date(sub.class_start_at).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });

  return (
    <div
      className={`grid gap-2 rounded-2xl p-3 shadow-sm ${
        cancelled ? "bg-surface-container-high" : "bg-surface-container-low"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-on-surface">
            {sub.substitute_teacher ?? "Unnamed teacher"}
            <span className="font-normal text-on-surface-variant">
              {" "}
              covering {sub.absent_teacher ?? "an unnamed teacher"}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            {sub.class_title?.trim() || "Untitled class"} · {when} · {sub.school_name ?? "Unknown school"}
            {sub.region ? ` — ${REGION_LABELS[sub.region as Region]}` : ""}
          </p>
        </div>
        {cancelled && (
          <span className="shrink-0 rounded-full bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
            Cancelled
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-surface-container-high px-2 py-1 text-on-surface-variant">
          {sub.reason ?? "No reason recorded"}
        </span>
        {!cancelled && <CalendarChip status={sub.calendar_write_status} />}
      </div>

      {sub.reason_notes && (
        <p className="text-xs text-on-surface-variant">{sub.reason_notes}</p>
      )}
      {cancelled && sub.cancel_reason && (
        <p className="text-xs text-on-surface-variant">Cancelled: {sub.cancel_reason}</p>
      )}

      {!cancelled &&
        (open ? (
          <form action={formAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="substitution_id" value={sub.id} />
            <input
              type="text"
              name="cancel_reason"
              required
              placeholder="Why is this cover no longer happening?"
              className="min-w-0 flex-1 rounded-lg bg-surface-container px-3 py-2 text-xs text-on-surface outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={pending}
              className="shrink-0 rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface disabled:opacity-50"
            >
              {pending ? "Cancelling…" : "Cancel cover"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-full px-3 py-2 text-xs font-bold text-on-surface-variant"
            >
              Keep it
            </button>
            {state?.error && (
              <p role="alert" className="w-full text-xs text-error">
                {state.error}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="justify-self-start text-xs font-bold text-primary underline"
          >
            Cancel this cover
          </button>
        ))}

      {state?.success && <p className="text-xs text-tertiary">{state.success}</p>}
    </div>
  );
}

function CalendarChip({ status }: { status: Substitution["calendar_write_status"] }) {
  if (status === "written") {
    return (
      <span className="rounded-full bg-tertiary-container px-2 py-1 text-on-tertiary-container">
        Google event updated
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="rounded-full bg-surface-container-high px-2 py-1 text-on-surface-variant">
        Updating Google event…
      </span>
    );
  }
  // 'manual' and 'failed' both mean the same thing to the person reading this —
  // the calendar does not say what the app says, and the substitute cannot
  // clock in until somebody fixes it.
  return (
    <span className="rounded-full bg-warning-container px-2 py-1 text-on-warning-container">
      {status === "failed" ? "Google update failed — edit by hand" : "Google event needs editing"}
    </span>
  );
}
