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
    <div className="rounded-2xl border border-foreground/10 p-4">
      <form onSubmit={runSearch} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search classes, teachers, schools…"
          className="flex-1 rounded-lg border border-foreground/20 bg-transparent px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-50"
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
                className="block rounded-lg px-2 py-1 text-sm hover:bg-foreground/5"
              >
                {e.summary || "Untitled event"}
                {e.school_name ? ` · ${e.school_name}` : ""}
              </Link>
            ))}
          </ResultColumn>
          <ResultColumn heading="Attendance records">
            {results.sessions.length === 0 && <Empty />}
            {results.sessions.map((s) => (
              <div key={s.id} className="rounded-lg px-2 py-1 text-sm">
                {s.teacher_name} · {s.school_name ?? "—"} ·{" "}
                {new Date(s.clock_in_at).toLocaleDateString()} ({s.clock_in_status})
              </div>
            ))}
          </ResultColumn>
          <ResultColumn heading="Schools">
            {results.schools.length === 0 && <Empty />}
            {results.schools.map((s) => (
              <div key={s.id} className="rounded-lg px-2 py-1 text-sm">
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
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-60">{heading}</h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="text-sm opacity-50">No matches.</p>;
}
