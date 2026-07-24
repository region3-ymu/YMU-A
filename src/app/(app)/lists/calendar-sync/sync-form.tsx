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
          className="text-sm underline opacity-70 hover:opacity-100"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50"
          >
            {pending
              ? "Syncing…"
              : selected.size === 0
                ? "Sync all calendars"
                : `Sync ${selected.size} selected`}
          </button>
        </div>
      </div>

      <ul className="grid max-h-96 gap-1 overflow-y-auto rounded-xl border border-foreground/10 p-2 sm:grid-cols-2">
        {schools.map((school) => (
          <li key={school.id}>
            <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-foreground/5">
              <input
                type="checkbox"
                name="school_id"
                value={school.id}
                checked={selected.has(school.id)}
                onChange={() => toggleOne(school.id)}
                className="shrink-0"
              />
              {school.name}
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs opacity-60">
        Leave everything unchecked to sync every school. Checking one or more syncs only those.
      </p>

      {state?.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}

      {state?.summary && !state.summary.skipped && (
        <div className="rounded-xl border border-foreground/10 p-4 text-sm">
          <p className="font-semibold">
            Done{state.summary.partial ? " (partial — some calendars left for the next run)" : ""}.
          </p>
          <p className="mt-1 opacity-80">
            {state.summary.discovered} calendars discovered · {state.summary.autoMatched} auto-matched ·{" "}
            {state.summary.issuesRaised} need attention · {state.summary.synced.length} synced this run
          </p>
          {state.summary.synced.some((s) => s.error) && (
            <ul className="mt-2 grid gap-1 text-red-600 dark:text-red-400">
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
        <p className="text-sm opacity-70">
          Another sync was already running — nothing to do, try again shortly.
        </p>
      )}
    </form>
  );
}
