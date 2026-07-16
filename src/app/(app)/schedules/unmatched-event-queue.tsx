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
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 className="font-semibold">School matching needs attention</h2>
      <p className="mt-1 text-sm opacity-75">
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
    <form action={formAction} className="rounded-lg border border-foreground/10 bg-background p-3">
      <input type="hidden" name="event_id" value={event.id} />
      <p className="font-medium">{eventTitle(event)}</p>
      <p className="mt-0.5 text-sm opacity-70">{formatEventTime(event)}</p>
      <p className="mt-1 text-sm"><span className="font-medium">Google Location:</span> {event.location_raw || "No Location supplied"}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`school-${event.id}`}>School for {eventTitle(event)}</label>
        <select id={`school-${event.id}`} name="school_id" required defaultValue="" className="min-w-56 rounded-md border border-foreground/20 bg-background px-2 py-1.5 text-sm">
          <option value="" disabled>Choose school…</option>
          {schools.map((school) => <option key={school.id} value={school.id}>{school.name}{school.region ? ` (${school.region})` : ""}</option>)}
        </select>
        <button type="submit" disabled={pending || !schools.length} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50">
          {pending ? "Assigning…" : "Assign school"}
        </button>
      </div>
      {state?.error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>}
      {state?.success && <p className="mt-2 text-sm text-green-700 dark:text-green-400">{state.success}</p>}
    </form>
  );
}
