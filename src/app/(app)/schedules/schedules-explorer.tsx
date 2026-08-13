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
  const groups = useMemo(() => groupByDay(visibleEvents, now), [visibleEvents, now]);
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

// Where a class sits relative to now: 0 = happening, 1 = still to come,
// 2 = over. The whole ordering rests on this, and the buckets are ranked
// rather than the times sorted, because "what should I look at" is not the
// same question as "what happens next".
function shiftRank(event: ScheduleEvent, now: Date): 0 | 1 | 2 {
  if (isCurrentlyInShift(event, now)) return 0;
  const endsAt = event.end_at ?? event.start_at;
  if (endsAt && new Date(endsAt).getTime() < now.getTime()) return 2;
  return 1;
}

function groupByDay(events: ScheduleEvent[], now: Date) {
  const groups = new Map<string, ScheduleEvent[]>();
  for (const event of events) {
    const key = dayKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  // Within a day: in-shift first, then upcoming, then finished — and
  // chronological inside each bucket. On any day other than today every class
  // falls in one bucket, so this is a no-op there and the ordering stays
  // purely chronological, which is what a manager reading next week expects.
  for (const [key, dayEvents] of groups) {
    groups.set(key, [...dayEvents].sort((left, right) => {
      const byRank = shiftRank(left, now) - shiftRank(right, now);
      if (byRank !== 0) return byRank;
      return (left.start_at ?? "").localeCompare(right.start_at ?? "");
    }));
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function EventCard({ event, now, managersView }: { event: ScheduleEvent; now: Date; managersView: boolean }) {
  const rank = shiftRank(event, now);
  const currentlyInShift = rank === 0;
  const finished = rank === 2;
  const schoolName = event.school?.name ?? (event.location_raw ? "School not matched" : "No school location");
  return (
    <Link
      href={`/schedules/${event.id}`}
      // Finished classes recede rather than disappear: still readable, still
      // tappable — a teacher often needs the one that just ended, to file its
      // feedback — but visibly no longer the thing to act on.
      className={`relative block overflow-hidden rounded-2xl p-4 pl-5 shadow-sm transition-transform active:scale-[0.99] ${
        finished ? "bg-surface-container-low opacity-60" : "bg-surface-container"
      }`}
    >
      <div
        className={`absolute inset-y-0 left-0 w-1.5 ${
          currentlyInShift ? "bg-tertiary" : finished ? "bg-outline-variant" : "bg-primary"
        }`}
        aria-hidden
      />
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
        {finished && (
          <span className="rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-semibold text-on-surface-variant">
            Finished
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
