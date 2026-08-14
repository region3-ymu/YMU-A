import { APP_TIME_ZONE, formatTimeRange, formatWeekdayShort } from "@/lib/format/datetime";
import type { ScheduleEvent } from "./types";

export function eventTitle(event: Pick<ScheduleEvent, "summary">) {
  return event.summary?.trim() || "Untitled event";
}

export function formatEventTime(event: ScheduleEvent) {
  if (event.all_day) {
    // calendar-sync stores an all-day event's date as midnight UTC
    // (`${date}T00:00:00.000Z`, see eventTime() in sync.ts), so start_at is
    // the whole answer — no need to dig the original date back out of `raw`,
    // which is 85-90% of this table's bytes and is not fetched for the list.
    if (!event.start_at) return "All day";
    return (
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(event.start_at)) + " · All day"
    );
  }
  if (!event.start_at) return "Time unavailable";
  return `${formatWeekdayShort(event.start_at)} · ${formatTimeRange(event.start_at, event.end_at)}`;
}

/**
 * Which day heading an event sits under.
 *
 * Miami time, not UTC. Grouping in UTC put a class starting at 8:30 PM local
 * under the NEXT day, because 8:30 PM ET is 00:30 UTC — the same failure
 * getNextClass() documents itself as avoiding. Every other user-facing time in
 * the app is rendered in APP_TIME_ZONE; the day a class belongs to has to
 * agree with the time printed on its own card.
 *
 * All-day events stay on UTC: they are stored as midnight UTC precisely so
 * they represent a calendar date rather than an instant, and converting one to
 * Miami time would move it to the day before.
 */
export function dayKey(event: ScheduleEvent) {
  if (!event.start_at) return "Unscheduled";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: event.all_day ? "UTC" : APP_TIME_ZONE,
  }).format(new Date(event.start_at));
}

export function dayHeading(key: string) {
  if (key === "Unscheduled") return key;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}T00:00:00Z`));
}

export function isCurrentlyInShift(event: ScheduleEvent, now: Date) {
  return !event.all_day && Boolean(
    event.start_at &&
      event.end_at &&
      new Date(event.start_at).getTime() <= now.getTime() &&
      now.getTime() < new Date(event.end_at).getTime(),
  );
}
