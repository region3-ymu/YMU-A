"use client";

// Shared search box mounted on both the Reports page and the Manager
// Dashboard. Runs searchAllAction() (src/lib/reports/search-action.ts),
// which is RLS-scoped through the caller's own session — no role check
// needed here, a teacher just gets fewer/narrower results than a manager.

import { useState, useTransition } from "react";
import Link from "next/link";
import { searchAllAction } from "@/lib/reports/search-action";
import type { SearchResults } from "@/lib/reports/search";

export default function SearchBox() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [pending, startTransition] = useTransition();

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query;
    startTransition(async () => {
      setResults(await searchAllAction(q));
    });
  }

  return (
    <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <form onSubmit={runSearch} className="flex gap-2">
        <div className="relative flex-1">
          <span
            className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-on-surface-variant"
            aria-hidden
          >
            search
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search classes, teachers, schools…"
            className="w-full rounded-lg bg-surface-container-low py-2 pl-10 pr-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-primary px-5 py-2 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Searching…" : "Search"}
        </button>
      </form>

      {results && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <ResultColumn heading="Classes">
            {results.events.length === 0 && <Empty />}
            {results.events.map((e) => (
              <Link
                key={e.id}
                href={`/schedules/${e.id}`}
                className="block rounded-lg px-2 py-1 text-sm text-on-surface hover:bg-surface-container-high"
              >
                {e.summary || "Untitled event"}
                {e.school_name ? ` · ${e.school_name}` : ""}
              </Link>
            ))}
          </ResultColumn>
          <ResultColumn heading="Attendance records">
            {results.sessions.length === 0 && <Empty />}
            {results.sessions.map((s) => (
              <div key={s.id} className="rounded-lg px-2 py-1 text-sm text-on-surface">
                {s.teacher_name} · {s.school_name ?? "—"} ·{" "}
                {new Date(s.clock_in_at).toLocaleDateString()} ({s.clock_in_status})
              </div>
            ))}
          </ResultColumn>
          <ResultColumn heading="Schools">
            {results.schools.length === 0 && <Empty />}
            {results.schools.map((s) => (
              <div key={s.id} className="rounded-lg px-2 py-1 text-sm text-on-surface">
                {s.name}
              </div>
            ))}
          </ResultColumn>
        </div>
      )}
    </div>
  );
}

function ResultColumn({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{heading}</h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-on-surface-variant">No matches.</p>;
}
