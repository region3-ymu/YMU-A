// Single source of truth for displaying wall-clock times to users.
//
// YMU operates entirely in Miami — every school is in US Eastern Time. A
// class scheduled "12:30 PM" must ALWAYS render as 12:30 PM to everyone,
// regardless of where the formatting code happens to run. That last part is
// the trap this module exists to close: `new Intl.DateTimeFormat(undefined,
// …)` (no timeZone) uses the *runtime's* zone — which for a React Server
// Component is the Vercel server, and Vercel runs in **UTC**. So a 12:30 PM
// Eastern class (stored as 16:30 UTC) rendered "4:30 PM" on every
// server-rendered surface (Clocking, event detail, Flags, Dashboard, Home),
// while the one client-rendered surface (the Schedules list) happened to
// look right only because it ran on a teacher's Miami phone. Confirmed live:
// a 12:30–2:30 class showed 4:30–6:30 on the clock-in screen.
//
// Pinning `America/New_York` here makes every surface agree and show the real
// Miami time. Use the IANA zone name, NOT a fixed offset — it handles DST
// automatically (UTC-4 in summer, UTC-5 in winter).
//
// NOTE: this is deliberately separate from the UTC *day-bucketing* convention
// used by reports/aggregate.ts, which keys rows into day/week buckets on UTC
// boundaries on purpose. Schedules' dayKey used to do the same and no longer
// does: grouping a class by UTC day put an 8:30 PM Miami class under the next
// day, so it now uses APP_TIME_ZONE like everything else a teacher reads.

export const APP_TIME_ZONE = "America/New_York";

function fmt(iso: string | number | Date | null | undefined, options: Intl.DateTimeFormatOptions): string {
  if (iso == null || iso === "") return "";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: APP_TIME_ZONE }).format(date);
}

// "2:00 PM"
export function formatTime(iso: string | number | Date | null | undefined): string {
  return fmt(iso, { hour: "numeric", minute: "2-digit" });
}

// "2:00 PM – 3:30 PM" (or just the start if there's no end)
export function formatTimeRange(
  startIso: string | number | Date | null | undefined,
  endIso: string | number | Date | null | undefined,
): string {
  const start = formatTime(startIso);
  if (!start) return "";
  const end = formatTime(endIso);
  return end ? `${start} – ${end}` : start;
}

// "Jul 28, 2026, 2:00 PM" — replaces Date.toLocaleString()
export function formatDateTime(iso: string | number | Date | null | undefined): string {
  return fmt(iso, { dateStyle: "medium", timeStyle: "short" });
}

// "Jul 28, 2026" — replaces Date.toLocaleDateString()
export function formatDate(iso: string | number | Date | null | undefined): string {
  return fmt(iso, { dateStyle: "medium" });
}

// "Tuesday, July 28" — long weekday+date, no year (headers)
export function formatWeekdayLong(iso: string | number | Date | null | undefined): string {
  return fmt(iso, { weekday: "long", month: "long", day: "numeric" });
}

// "Tue, Jul 28, 2026" — short weekday+date+year
export function formatWeekdayShort(iso: string | number | Date | null | undefined): string {
  return fmt(iso, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
