"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { isManagerRole, REGION_LABELS, type Region } from "@/lib/auth/roles";
import { dayHeading, dayKey, eventTitle, formatEventTime, isCurrentlyInShift } from "./format";
import UnmatchedCalendarQueue from "./unmatched-calendar-queue";
import UnmatchedEventQueue from "./unmatched-event-queue";
import type { SchedulesExplorerProps, ScheduleEvent } from "./types";

export default function SchedulesExplorer({ events, schools, calendarIssues, callerRole, now: initialNow }: SchedulesExplorerProps) {
  const managersView = isManagerRole(callerRole);
  const [now, setNow] = useState(() => new Date(initialNow));
  const [region, setRegion] = useState<Region | "all">("all");
  const [schoolId, setSchoolId] = useState("all");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleEvents = useMemo(() => events.filter((event) => {
    if (region !== "all" && event.school?.region !== region) return false;
    if (schoolId !== "all" && event.school_id !== schoolId) return false;
    return true;
  }), [events, region, schoolId]);
  const groups = useMemo(() => groupByDay(visibleEvents), [visibleEvents]);
  const unmatched = managersView ? events.filter((event) => !event.school_id && event.status !== "cancelled") : [];
  const schoolsWithoutCalendar = managersView ? schools.filter((school) => !school.google_calendar_id) : [];

  return (
    <div className="grid gap-6">
      {managersView && (
        <div className="flex flex-wrap gap-3 rounded-xl border border-foreground/10 p-3">
          <label className="grid gap-1 text-sm font-medium">Region
            <select value={region} onChange={(event) => setRegion(event.target.value as Region | "all")} className="rounded-md border border-foreground/20 bg-background px-2 py-1.5 font-normal">
              <option value="all">All visible regions</option>
              {Object.entries(REGION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">School
            <select value={schoolId} onChange={(event) => setSchoolId(event.target.value)} className="rounded-md border border-foreground/20 bg-background px-2 py-1.5 font-normal">
              <option value="all">All visible schools</option>
              {schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
            </select>
          </label>
        </div>
      )}

      {managersView && <UnmatchedCalendarQueue issues={calendarIssues} schools={schoolsWithoutCalendar} />}
      {managersView && <UnmatchedEventQueue events={unmatched} schools={schools} />}

      {groups.length ? (
        <div className="grid gap-6">
          {groups.map(([key, dayEvents]) => (
            <section key={key}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-65">{dayHeading(key)}</h2>
              <div className="grid gap-2">
                {dayEvents.map((event) => <EventCard key={event.id} event={event} now={now} managersView={managersView} />)}
              </div>
            </section>
          ))}
        </div>
      ) : <p className="rounded-xl border border-dashed border-foreground/20 p-6 text-sm opacity-70">No scheduled events match these filters.</p>}
    </div>
  );
}

function groupByDay(events: ScheduleEvent[]) {
  const groups = new Map<string, ScheduleEvent[]>();
  for (const event of events) {
    const key = dayKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function EventCard({ event, now, managersView }: { event: ScheduleEvent; now: Date; managersView: boolean }) {
  const currentlyInShift = isCurrentlyInShift(event, now);
  const schoolName = event.school?.name ?? (event.location_raw ? "School not matched" : "No school location");
  return (
    <Link href={`/schedules/${event.id}`} className="block rounded-xl border border-foreground/10 p-4 transition hover:border-accent hover:bg-accent/5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{eventTitle(event)}</h3>
          <p className="mt-0.5 text-sm opacity-75">{formatEventTime(event)}</p>
        </div>
        {currentlyInShift && <span className="rounded-full bg-green-600 px-2.5 py-0.5 text-xs font-semibold text-white">Currently in shift</span>}
      </div>
      <p className="mt-2 text-sm"><span className="font-medium">{schoolName}</span>{event.location_raw && event.school ? ` · ${event.location_raw}` : ""}</p>
      {managersView && <p className="mt-1 text-xs opacity-65">{event.teacher_ids.length ? `${event.teacher_ids.length} matched teacher${event.teacher_ids.length === 1 ? "" : "s"}` : "No teacher matched"}{event.school?.region ? ` · ${REGION_LABELS[event.school.region]}` : ""}</p>}
    </Link>
  );
}
