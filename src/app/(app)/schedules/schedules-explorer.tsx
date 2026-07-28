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
        <div className="flex flex-wrap gap-3 rounded-2xl bg-surface-container p-4 shadow-sm">
          <label className="grid gap-1 text-sm font-medium text-on-surface">Region
            <select value={region} onChange={(event) => setRegion(event.target.value as Region | "all")} className="rounded-lg bg-surface-container-low px-3 py-2 font-normal text-on-surface outline-none focus:ring-2 focus:ring-primary">
              <option value="all">All visible regions</option>
              {Object.entries(REGION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-on-surface">School
            <select value={schoolId} onChange={(event) => setSchoolId(event.target.value)} className="rounded-lg bg-surface-container-low px-3 py-2 font-normal text-on-surface outline-none focus:ring-2 focus:ring-primary">
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
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-on-surface-variant">{dayHeading(key)}</h2>
              <div className="grid gap-3">
                {dayEvents.map((event) => <EventCard key={event.id} event={event} now={now} managersView={managersView} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>event_busy</span>
          <p className="text-sm text-on-surface-variant">No scheduled events match these filters.</p>
        </div>
      )}
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
    <Link
      href={`/schedules/${event.id}`}
      className="relative block overflow-hidden rounded-2xl bg-surface-container p-4 pl-5 shadow-sm transition-transform active:scale-[0.99]"
    >
      <div className={`absolute inset-y-0 left-0 w-1.5 ${currentlyInShift ? "bg-tertiary" : "bg-primary"}`} aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-on-surface">{eventTitle(event)}</h3>
          <p className="mt-0.5 flex items-center gap-1 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base" aria-hidden>schedule</span>
            {formatEventTime(event)}
          </p>
        </div>
        {currentlyInShift && (
          <span className="flex items-center gap-1 rounded-full bg-tertiary-container px-2.5 py-1 text-xs font-semibold text-on-tertiary-container">
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
            In shift
          </span>
        )}
      </div>
      <p className="mt-2 flex items-center gap-1 text-sm text-on-surface">
        <span className="material-symbols-outlined text-base text-on-surface-variant" aria-hidden>location_on</span>
        <span className="font-medium">{schoolName}</span>{event.location_raw && event.school ? ` · ${event.location_raw}` : ""}
      </p>
      {managersView && <p className="mt-1 text-xs text-on-surface-variant">{event.teacher_ids.length ? `${event.teacher_ids.length} matched teacher${event.teacher_ids.length === 1 ? "" : "s"}` : "No teacher matched"}{event.school?.region ? ` · ${REGION_LABELS[event.school.region]}` : ""}</p>}
    </Link>
  );
}
