import { formatTimeRange, formatWeekdayShort } from "@/lib/format/datetime";
import type { ScheduleEvent } from "./types";

function rawDate(event: ScheduleEvent, key: "start" | "end") {
  const raw = event.raw?.[key];
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as { date?: unknown }).date;
  return typeof value === "string" ? value : null;
}

export function eventTitle(event: Pick<ScheduleEvent, "summary">) {
  return event.summary?.trim() || "Untitled event";
}

export function formatEventTime(event: ScheduleEvent) {
  if (event.all_day) {
    const date = rawDate(event, "start");
    return date
      ? new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)) + " · All day"
      : "All day";
  }
  if (!event.start_at) return "Time unavailable";
  return `${formatWeekdayShort(event.start_at)} · ${formatTimeRange(event.start_at, event.end_at)}`;
}

export function dayKey(event: ScheduleEvent) {
  if (event.all_day) return rawDate(event, "start") ?? "Unscheduled";
  if (!event.start_at) return "Unscheduled";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(event.start_at));
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
