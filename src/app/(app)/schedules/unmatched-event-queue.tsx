"use client";

import { useActionState } from "react";
import { assignEventSchool, type ScheduleFormState } from "./actions";
import { eventTitle, formatEventTime } from "./format";
import type { ScheduleEvent, ScheduleSchool } from "./types";

const initialState: ScheduleFormState = undefined;

export default function UnmatchedEventQueue({
  events,
  schools,
}: {
  events: ScheduleEvent[];
  schools: ScheduleSchool[];
}) {
  if (!events.length) return null;

  return (
    <section className="rounded-2xl bg-warning-container p-4 text-on-warning-container shadow-sm">
      <h2 className="flex items-center gap-2 font-semibold"><span className="material-symbols-outlined" aria-hidden>warning</span>School matching needs attention</h2>
      <p className="mt-1 text-sm">
        These events did not meet the automatic Location-match threshold. Assigning a school here is retained until Google Calendar’s Location changes.
      </p>
      <div className="mt-3 grid gap-3">
        {events.map((event) => <UnmatchedEvent key={event.id} event={event} schools={schools} />)}
      </div>
    </section>
  );
}

function UnmatchedEvent({ event, schools }: { event: ScheduleEvent; schools: ScheduleSchool[] }) {
  const [state, formAction, pending] = useActionState(assignEventSchool, initialState);
  return (
    <form action={formAction} className="rounded-2xl bg-surface-container p-3 shadow-sm">
      <input type="hidden" name="event_id" value={event.id} />
      <p className="font-medium text-on-surface">{eventTitle(event)}</p>
      <p className="mt-0.5 flex items-center gap-1 text-sm text-on-surface-variant"><span className="material-symbols-outlined text-base" aria-hidden>schedule</span>{formatEventTime(event)}</p>
      <p className="mt-1 text-sm text-on-surface"><span className="font-medium">Google Location:</span> {event.location_raw || "No Location supplied"}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`school-${event.id}`}>School for {eventTitle(event)}</label>
        <select id={`school-${event.id}`} name="school_id" required defaultValue="" className="min-w-56 rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary">
          <option value="" disabled>Choose school…</option>
          {schools.map((school) => <option key={school.id} value={school.id}>{school.name}{school.region ? ` (${school.region})` : ""}</option>)}
        </select>
        <button type="submit" disabled={pending || !schools.length} className="rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-50">
          {pending ? "Assigning…" : "Assign school"}
        </button>
      </div>
      {state?.error && <p role="alert" className="mt-2 text-sm text-error">{state.error}</p>}
      {state?.success && <p className="mt-2 text-sm text-tertiary">{state.success}</p>}
    </form>
  );
}
