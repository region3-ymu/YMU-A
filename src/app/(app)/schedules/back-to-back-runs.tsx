"use client";

import { useActionState, useMemo, useState } from "react";
import { REGION_LABELS, type AppRole, type Region } from "@/lib/auth/roles";
import { setAutoClockInRule, type ScheduleFormState } from "./actions";
import type { BackToBackRun } from "./types";

const initialState: ScheduleFormState = undefined;

/**
 * Where a manager decides which back-to-back runs stop asking for a second
 * clock-in.
 *
 * The evidence is on the row on purpose — gap, how many dates the run repeats
 * on, and how many late flags it has already produced. YMU's answer differed
 * per run for reasons that do not show up in the schedule (Horace Mann has no
 * usable internet; Madison is the same 5-minute gap and they want the clock-in
 * kept), so this screen has to support a judgement, not make one.
 */
export default function BackToBackRuns({
  runs,
  callerRole,
  canEdit,
}: {
  runs: BackToBackRun[];
  callerRole: AppRole;
  canEdit: boolean;
}) {
  const [region, setRegion] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const regions = useMemo(
    () => [...new Set(runs.map((r) => r.region).filter((r): r is Region => r != null))].sort(),
    [runs],
  );

  const shown = useMemo(
    () =>
      runs.filter(
        (run) =>
          (region === "" || run.region === region) && (!onlyFlagged || run.late_flags > 0),
      ),
    [runs, region, onlyFlagged],
  );

  if (!runs.length) return null;

  const activeCount = runs.filter((r) => r.rule_active).length;

  return (
    <section className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <h2 className="flex items-center gap-2 font-semibold text-on-surface">
        <span className="material-symbols-outlined" aria-hidden>
          fast_forward
        </span>
        Back-to-back classes
      </h2>
      <p className="mt-1 text-sm text-on-surface-variant">
        {runs.length} run{runs.length === 1 ? "" : "s"} where a teacher&apos;s next class at the same
        school starts within 30 minutes of the previous one ending, {activeCount} with auto clock-in
        on. With it on, clocking into the first class records the next one too — so the second class
        never raises a late flag, and nobody is asked to clock in from a room with no signal.
      </p>
      {!canEdit && (
        <p className="mt-2 text-xs text-on-surface-variant">
          Switching these on and off is the operations manager&apos;s or the CPO&apos;s call
          {callerRole === "regional_manager" ? " — ask them for a run in your region" : ""}.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="grid min-w-0 gap-1 text-xs font-medium text-on-surface-variant">
          Region
          <select
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            className="w-full min-w-0 truncate rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {REGION_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-4 flex items-center gap-2 text-xs font-medium text-on-surface">
          <input
            type="checkbox"
            checked={onlyFlagged}
            onChange={(event) => setOnlyFlagged(event.target.checked)}
            className="size-4 accent-primary"
          />
          Only runs that have already been flagged
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-on-surface-variant">No runs match those filters.</p>
      ) : (
        <div className="mt-3 grid gap-3">
          {shown.map((run) => (
            <Run
              key={`${run.school_id}:${run.teacher_id}:${run.first_start}:${run.second_start}`}
              run={run}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// The Wednesday bell schedule shifts every run by a few minutes, so the same
// pair shows up twice at different clock times. That is not a duplicate — the
// gap really is different that day — but it is worth labelling as one run seen
// twice rather than two separate arrangements.
function timeLabel(value: string): string {
  const [hour, minute] = value.split(":");
  const h = Number(hour);
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${minute}${suffix}`;
}

function Run({ run, canEdit }: { run: BackToBackRun; canEdit: boolean }) {
  const [state, formAction, pending] = useActionState(setAutoClockInRule, initialState);

  return (
    <div className="grid gap-2 rounded-2xl bg-surface-container-low p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-on-surface">
            {run.teacher_name ?? "Unnamed teacher"}
            <span className="font-normal text-on-surface-variant"> · {run.school_name}</span>
          </p>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            {run.first_class?.trim() || "Untitled"} {timeLabel(run.first_start)}–
            {timeLabel(run.first_end)} → {run.second_class?.trim() || "Untitled"}{" "}
            {timeLabel(run.second_start)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
            run.rule_active
              ? "bg-primary text-on-primary"
              : "bg-surface-container-high text-on-surface-variant"
          }`}
        >
          {run.rule_active ? "Auto clock-in on" : "Normal clock-in"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-surface-container-high px-2 py-1 text-on-surface-variant">
          {/* Negative on purpose at Little River, where Tutoring is scheduled to
              start five minutes before Beginning Band ends. */}
          {run.gap_minutes < 0
            ? `Overlaps by ${Math.abs(run.gap_minutes)} min`
            : `${run.gap_minutes} min gap`}
        </span>
        <span className="rounded-full bg-surface-container-high px-2 py-1 text-on-surface-variant">
          {run.occurrences} date{run.occurrences === 1 ? "" : "s"}
        </span>
        <span
          className={`rounded-full px-2 py-1 ${
            run.late_flags > 0
              ? "bg-error-container text-on-error-container"
              : "bg-surface-container-high text-on-surface-variant"
          }`}
        >
          {run.late_flags} late flag{run.late_flags === 1 ? "" : "s"}
        </span>
        {run.is_afterschool && (
          <span className="rounded-full bg-tertiary-container px-2 py-1 text-on-tertiary-container">
            Afterschool
          </span>
        )}
      </div>

      {canEdit && (
        <form action={formAction} className="mt-1 flex flex-wrap items-center gap-2">
          <input type="hidden" name="school_id" value={run.school_id} />
          <input type="hidden" name="teacher_id" value={run.teacher_id ?? ""} />
          {/* Present only when turning ON. The action reads active as
              `=== "on"`, so its absence is the "off" — one form, one button,
              no state to get out of step with the badge above. */}
          {!run.rule_active && <input type="hidden" name="active" value="on" />}
          {!run.rule_active && (
            <input
              type="text"
              name="note"
              placeholder="Why turn this on? (recorded on the rule)"
              className="min-w-0 flex-1 rounded-lg bg-surface-container px-3 py-2 text-xs text-on-surface outline-none focus:ring-2 focus:ring-primary"
            />
          )}
          <button
            type="submit"
            disabled={pending}
            className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50 ${
              run.rule_active
                ? "border-2 border-outline text-on-surface"
                : "bg-primary text-on-primary"
            }`}
          >
            {pending ? "Saving…" : run.rule_active ? "Turn off" : "Turn on auto clock-in"}
          </button>
          {state?.error && (
            <p role="alert" className="w-full text-xs text-error">
              {state.error}
            </p>
          )}
          {state?.success && <p className="w-full text-xs text-tertiary">{state.success}</p>}
        </form>
      )}
    </div>
  );
}
