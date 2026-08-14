// How far ahead the Schedules list looks.
//
// It used to look at everything: `end_at >= today` with no upper bound, which
// on 2026-08-14 was 6,987 events in one server render, growing all year. The
// next seven days is 194 of them. Nobody scrolls to June.
//
// Deliberately NOT lib/reports/range.ts. That one looks backwards, its presets
// are `lastNDays`, and it clamps everything to DATA_START_DATE — a floor that
// is meaningless on a future-facing list and would put "(from 2026-08-13)" on
// every label here. The two answer opposite questions and sharing the type
// would only invite one to be "fixed" into breaking the other.
//
// Pure and dependency-free, with `now` injectable, so the presets are testable
// without a database — same arrangement as the reports version.

// Relative, not "@/…": these presets are unit-tested directly and vitest does
// not resolve the tsconfig path alias — the same reason lib/reports/range.ts
// imports its neighbour relatively.
import { APP_TIME_ZONE } from "../format/datetime";

export type ScheduleRange = {
  key: ScheduleRangeKey;
  label: string;
  /** Inclusive lower bound, ISO instant. Always the start of today in Miami. */
  from: string;
  /** Exclusive upper bound, ISO instant. */
  to: string;
};

export const SCHEDULE_RANGE_KEYS = ["today", "week", "month"] as const;
export type ScheduleRangeKey = (typeof SCHEDULE_RANGE_KEYS)[number];

export const DEFAULT_SCHEDULE_RANGE: ScheduleRangeKey = "week";

const DAY_MS = 24 * 60 * 60 * 1000;

const LABELS: Record<ScheduleRangeKey, string> = {
  today: "Today",
  week: "Next 7 days",
  month: "Next 30 days",
};

const DAYS: Record<ScheduleRangeKey, number> = { today: 1, week: 7, month: 30 };

export function scheduleRangeOptions(): { key: ScheduleRangeKey; label: string }[] {
  return SCHEDULE_RANGE_KEYS.map((key) => ({ key, label: LABELS[key] }));
}

export function isScheduleRangeKey(value: unknown): value is ScheduleRangeKey {
  return typeof value === "string" && (SCHEDULE_RANGE_KEYS as readonly string[]).includes(value);
}

/**
 * Bounds for a range key. An unknown or missing key falls back to the default
 * rather than throwing — a stale bookmark should render a page, not a crash.
 *
 * The window starts at midnight in Miami, not at `now`: a teacher opening this
 * at 2pm still wants to see the class they taught this morning, and "Today"
 * that hides most of today is a lie.
 */
export function resolveScheduleRange(
  key: string | undefined | null,
  now: number = Date.now(),
): ScheduleRange {
  const effective: ScheduleRangeKey = isScheduleRangeKey(key) ? key : DEFAULT_SCHEDULE_RANGE;
  const start = startOfLocalDay(now);
  return {
    key: effective,
    label: LABELS[effective],
    from: new Date(start).toISOString(),
    to: new Date(start + DAYS[effective] * DAY_MS).toISOString(),
  };
}

/**
 * Midnight in America/New_York for the day containing `now`, as an epoch.
 *
 * The page previously used `new Date().setHours(0, 0, 0, 0)`, which is
 * midnight in the SERVER's zone — on a UTC host that is 8pm the previous day
 * in Miami, so "today" quietly began the evening before and dragged in
 * yesterday's late classes.
 */
export function startOfLocalDay(now: number = Date.now()): number {
  const offset = zoneOffsetMs(now);
  // Shift into "wall clock read as if it were UTC", floor to the day, shift back.
  const localMidnight = Math.floor((now + offset) / DAY_MS) * DAY_MS;
  const utc = localMidnight - offset;
  // The offset can differ at the candidate instant on the two DST changeover
  // days a year. Recompute once there rather than being an hour out twice a
  // year — America/New_York has both.
  const settled = zoneOffsetMs(utc);
  return settled === offset ? utc : localMidnight - settled;
}

/**
 * How far APP_TIME_ZONE is from UTC at a given instant, in ms (negative for
 * Miami). Derived by reading the wall clock in that zone and treating it as
 * UTC — Intl is the only thing that knows the DST rules.
 */
function zoneOffsetMs(at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIME_ZONE,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl can render midnight as "24" in some engines.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - at;
}
