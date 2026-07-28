"use client";

import { useActionState, useState } from "react";
import { triggerCalendarSync } from "./actions";

export default function SyncForm({ schools }: { schools: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(triggerCalendarSync, undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allSelected = schools.length > 0 && selected.size === schools.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(schools.map((s) => s.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggleAll}
          className="text-sm font-medium text-primary"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>
              sync
            </span>
            {pending
              ? "Syncing…"
              : selected.size === 0
                ? "Sync all calendars"
                : `Sync ${selected.size} selected`}
          </button>
        </div>
      </div>

      <ul className="grid max-h-96 gap-1 overflow-y-auto rounded-2xl bg-surface-container p-2 shadow-sm sm:grid-cols-2">
        {schools.map((school) => (
          <li key={school.id}>
            <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-on-surface hover:bg-surface-container-high">
              <input
                type="checkbox"
                name="school_id"
                value={school.id}
                checked={selected.has(school.id)}
                onChange={() => toggleOne(school.id)}
                className="shrink-0 accent-primary"
              />
              {school.name}
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-on-surface-variant">
        Leave everything unchecked to sync every school. Checking one or more syncs only those.
      </p>

      {state?.error && (
        <p role="alert" className="rounded-2xl bg-error-container px-4 py-3 text-sm text-on-error-container shadow-sm">
          {state.error}
        </p>
      )}

      {state?.summary && !state.summary.skipped && (
        <div className="rounded-2xl bg-surface-container p-4 text-sm shadow-sm">
          <p className="font-semibold text-on-surface">
            Done{state.summary.partial ? " (partial — some calendars left for the next run)" : ""}.
          </p>
          <p className="mt-1 text-on-surface-variant">
            {state.summary.discovered} calendars discovered · {state.summary.autoMatched} auto-matched ·{" "}
            {state.summary.issuesRaised} need attention · {state.summary.synced.length} synced this run
          </p>
          {state.summary.synced.some((s) => s.error) && (
            <ul className="mt-2 grid gap-1 text-error">
              {state.summary.synced
                .filter((s) => s.error)
                .map((s) => (
                  <li key={s.calendarId}>
                    {s.calendarId}: {s.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {state?.summary && state.summary.skipped && (
        <p className="text-sm text-on-surface-variant">
          Another sync was already running — nothing to do, try again shortly.
        </p>
      )}
    </form>
  );
}
