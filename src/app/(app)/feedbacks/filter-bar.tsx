"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type Option = { value: string; label: string };

// Filters as URL state, not component state: a manager who finds something
// worth showing someone can send the link, and the back button behaves. Each
// change navigates, so the server component re-runs the RLS-scoped query
// rather than filtering a list on the client that RLS already trimmed.
export default function FeedbackFilterBar({
  teachers,
  schools,
  engagementOptions,
  current,
}: {
  teachers: { id: string; name: string }[];
  schools: { id: string; name: string }[];
  engagementOptions: Option[];
  current: { teacher: string; school: string; from: string; to: string; engagement: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the page number — page 3 of the old
    // result set is rarely page 3 of the new one, and is often past its end.
    next.delete("page");
    startTransition(() => router.push(`/feedbacks?${next.toString()}`));
  }

  const anyActive = Object.values(current).some(Boolean);

  return (
    <div className={`grid gap-3 rounded-2xl bg-surface-container p-4 shadow-sm ${pending ? "opacity-60" : ""}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Teacher">
          <select
            value={current.teacher}
            onChange={(e) => setParam("teacher", e.target.value)}
            className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Everyone</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>

        <Field label="School">
          <select
            value={current.school}
            onChange={(e) => setParam("school", e.target.value)}
            className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All schools</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Engagement">
          <select
            value={current.engagement}
            onChange={(e) => setParam("engagement", e.target.value)}
            className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Any</option>
            {engagementOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <input
              type="date"
              value={current.from}
              onChange={(e) => setParam("from", e.target.value)}
              className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={current.to}
              onChange={(e) => setParam("to", e.target.value)}
              className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
        </div>
      </div>

      {anyActive && (
        <button
          type="button"
          onClick={() => startTransition(() => router.push("/feedbacks"))}
          className="justify-self-start text-sm font-semibold text-primary hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-on-surface-variant">{label}</span>
      {children}
    </label>
  );
}
