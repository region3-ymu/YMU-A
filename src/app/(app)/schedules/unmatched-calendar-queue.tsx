"use client";

import { useActionState } from "react";
import { resolveCalendarIssue, type ScheduleFormState } from "./actions";
import type { CalendarSyncIssue, ScheduleSchool } from "./types";

const initialState: ScheduleFormState = undefined;

const REASON_LABELS: Record<CalendarSyncIssue["reason"], string> = {
  no_matching_school: "No school matched this calendar's name",
  ambiguous_match: "Matched two schools too closely to auto-assign",
  school_already_linked: "Its best-matching school is already linked to a different calendar",
  sync_error: "This calendar failed to sync",
};

export default function UnmatchedCalendarQueue({
  issues,
  schools,
}: {
  issues: CalendarSyncIssue[];
  schools: ScheduleSchool[];
}) {
  if (!issues.length) return null;

  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 className="font-semibold">Calendars needing attention</h2>
      <p className="mt-1 text-sm opacity-75">
        These Google Calendars were discovered but couldn&apos;t be automatically linked to a school. Once linked, a
        calendar is synced going forward and won&apos;t be re-matched automatically.
      </p>
      <div className="mt-3 grid gap-3">
        {issues.map((issue) => <UnmatchedCalendar key={issue.id} issue={issue} schools={schools} />)}
      </div>
    </section>
  );
}

function UnmatchedCalendar({ issue, schools }: { issue: CalendarSyncIssue; schools: ScheduleSchool[] }) {
  const [state, formAction, pending] = useActionState(resolveCalendarIssue, initialState);
  return (
    <form action={formAction} className="rounded-lg border border-foreground/10 bg-background p-3">
      <input type="hidden" name="calendar_id" value={issue.calendar_id} />
      <p className="font-medium">{issue.calendar_summary || issue.calendar_id}</p>
      <p className="mt-0.5 text-sm opacity-70">{REASON_LABELS[issue.reason]}</p>
      {issue.candidates.length > 0 && (
        <p className="mt-1 text-sm opacity-70">
          Closest matches: {issue.candidates.map((candidate) => `${candidate.school_name} (${candidate.score.toFixed(2)})`).join(", ")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`calendar-school-${issue.id}`}>School for {issue.calendar_summary || issue.calendar_id}</label>
        <select id={`calendar-school-${issue.id}`} name="school_id" required defaultValue="" className="min-w-56 rounded-md border border-foreground/20 bg-background px-2 py-1.5 text-sm">
          <option value="" disabled>Choose school…</option>
          {schools.map((school) => <option key={school.id} value={school.id}>{school.name}{school.region ? ` (${school.region})` : ""}</option>)}
        </select>
        <button type="submit" disabled={pending || !schools.length} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50">
          {pending ? "Linking…" : "Link school"}
        </button>
        <button
          type="submit"
          formNoValidate
          disabled={pending}
          onClick={(event) => {
            // Submit with no school selected: dismiss-only, this calendar
            // isn't a school calendar (e.g. a shared "Holidays" calendar).
            const select = event.currentTarget.form?.elements.namedItem("school_id") as HTMLSelectElement | null;
            if (select) select.value = "";
          }}
          className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          Not a school calendar
        </button>
      </div>
      {state?.error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>}
      {state?.success && <p className="mt-2 text-sm text-green-700 dark:text-green-400">{state.success}</p>}
    </form>
  );
}
