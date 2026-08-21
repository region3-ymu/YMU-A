"use client";

import { useMemo, useState, useTransition } from "react";
import { REGION_LABELS, type AppRole, type Region } from "@/lib/auth/roles";
import { findSubstitutes } from "./actions";
import ConfirmSubstitutionForm from "./confirm-substitution-form";
import type { Candidate, CoverableClass, Substitution } from "./types";

const TIME_ZONE = "America/New_York";

function classLabel(c: CoverableClass): string {
  const start = new Date(c.startAt);
  const day = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: TIME_ZONE,
  });
  const time = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
  return `${day} ${time} · ${c.summary?.trim() || "Untitled class"}`;
}

// 2 is free plus both matches, 1 is free plus either, 0 is free and neither.
// The two ways of scoring 1 are treated as equally good, which is why they share
// a tier rather than being ordered against each other.
function tierFor(score: number): { label: string; tone: string } {
  if (score >= 2) return { label: "Best match", tone: "bg-primary text-on-primary" };
  if (score === 1) return { label: "Partial match", tone: "bg-secondary-container text-on-secondary-container" };
  return { label: "Last resort", tone: "bg-surface-container-high text-on-surface-variant" };
}

export default function SubstitutesFinder({
  classes,
  callerRole,
  substitutions,
}: {
  classes: CoverableClass[];
  callerRole: AppRole;
  substitutions: Substitution[];
}) {
  const [schoolId, setSchoolId] = useState("");
  const [eventId, setEventId] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const schools = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; region: Region | null }>();
    for (const c of classes) {
      if (!seen.has(c.schoolId)) seen.set(c.schoolId, { id: c.schoolId, name: c.schoolName, region: c.region });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [classes]);

  const classesForSchool = useMemo(
    () => classes.filter((c) => c.schoolId === schoolId),
    [classes, schoolId]
  );

  const selected = classesForSchool.find((c) => c.id === eventId) ?? null;

  // Cover already booked for this class. Two managers looking at the same
  // absence on the same morning is exactly how a class gets two substitutes,
  // and confirm_substitution() supersedes rather than refuses — so the warning
  // has to be here, before the second one is confirmed.
  const alreadyCovered = useMemo(
    () => substitutions.filter((sub) => sub.event_id === eventId && sub.status === "confirmed"),
    [substitutions, eventId]
  );

  const search = () => {
    if (!eventId) return;
    setError(null);
    setCandidates(null);
    startTransition(async () => {
      const result = await findSubstitutes(eventId);
      if (result.ok) setCandidates(result.candidates);
      else setError(result.error);
    });
  };

  return (
    <div className="grid gap-6">
      <div className="grid min-w-0 gap-3 rounded-2xl bg-surface-container p-4 shadow-sm sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-sm font-medium text-on-surface">
          School
          <select
            value={schoolId}
            onChange={(event) => {
              setSchoolId(event.target.value);
              setEventId("");
              setCandidates(null);
              setError(null);
            }}
            className="w-full min-w-0 truncate rounded-lg bg-surface-container-low px-3 py-2 font-normal text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Select a school…</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.region ? ` — ${REGION_LABELS[s.region]}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="grid min-w-0 gap-1 text-sm font-medium text-on-surface">
          Class to cover
          <select
            value={eventId}
            onChange={(event) => {
              setEventId(event.target.value);
              setCandidates(null);
              setError(null);
            }}
            disabled={!schoolId}
            className="w-full min-w-0 truncate rounded-lg bg-surface-container-low px-3 py-2 font-normal text-on-surface outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
          >
            <option value="">{schoolId ? "Select a class…" : "Pick a school first"}</option>
            {classesForSchool.map((c) => (
              <option key={c.id} value={c.id}>
                {classLabel(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected && (
        <div className="grid gap-2 rounded-2xl bg-surface-container-low p-4 text-sm shadow-sm">
          <p className="text-on-surface">
            <span className="font-semibold">{selected.summary?.trim() || "Untitled class"}</span>
            {selected.program && (
              <span className="text-on-surface-variant"> · {selected.program}</span>
            )}
          </p>
          <p className="text-on-surface-variant">
            {selected.assignedTeachers.length > 0
              ? `Normally taught by ${selected.assignedTeachers.join(", ")}`
              : "No teacher is linked to this class yet"}
          </p>
          {alreadyCovered.map((sub) => (
            <p
              key={sub.id}
              className="rounded-lg bg-warning-container p-2 text-xs text-on-warning-container"
            >
              Already covered: {sub.substitute_teacher ?? "someone"} is standing in for{" "}
              {sub.absent_teacher ?? "the assigned teacher"}. Confirming another substitute replaces
              that record.
            </p>
          ))}
          <button
            type="button"
            onClick={search}
            disabled={pending}
            className="mt-1 justify-self-start rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary shadow-sm outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
          >
            {pending ? "Searching…" : "Find substitutes"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-2xl bg-error-container p-4 text-sm text-on-error-container shadow-sm">
          {error}
        </p>
      )}

      {candidates && candidates.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>
            person_off
          </span>
          <p className="text-sm text-on-surface-variant">
            Every teacher is already teaching during that hour.
          </p>
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <div className="grid gap-3">
          <p className="text-sm text-on-surface-variant">
            {candidates.length} teacher{candidates.length === 1 ? "" : "s"} free at that hour
            {callerRole === "regional_manager" && ", including other regions"}.
          </p>
          {candidates.map((c) => {
            const tier = tierFor(c.score);
            return (
              <div key={c.teacher_id} className="grid gap-2 rounded-2xl bg-surface-container p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-on-surface">{c.full_name ?? "Unnamed teacher"}</p>
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${tier.tone}`}>
                    {tier.label}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 text-xs">
                  <span
                    className={`rounded-full px-2 py-1 ${
                      c.same_region
                        ? "bg-tertiary-container text-on-tertiary-container"
                        : "bg-surface-container-high text-on-surface-variant"
                    }`}
                  >
                    {c.same_region ? "Same region" : "Other region"}
                  </span>
                  <span
                    className={`rounded-full px-2 py-1 ${
                      c.same_program
                        ? "bg-tertiary-container text-on-tertiary-container"
                        : "bg-surface-container-high text-on-surface-variant"
                    }`}
                  >
                    {c.same_program ? "Teaches this program" : "Different program"}
                  </span>
                </div>

                <p className="text-xs text-on-surface-variant">
                  {c.regions.length > 0
                    ? `Works: ${c.regions
                        .map((r) => REGION_LABELS[r as Region] ?? r)
                        .join(", ")}`
                    : "No classes on record"}
                  {c.programs.length > 0 && ` · Teaches: ${c.programs.join(", ")}`}
                </p>

                <div className="flex flex-wrap gap-3 text-xs">
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="text-primary underline">
                      {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a href={`tel:${c.phone}`} className="text-primary underline">
                      {c.phone}
                    </a>
                  )}
                </div>

                {/* Contacting them is still step one — the app cannot ask on
                    anyone's behalf. This records the answer. */}
                {selected && <ConfirmSubstitutionForm klass={selected} candidate={c} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
