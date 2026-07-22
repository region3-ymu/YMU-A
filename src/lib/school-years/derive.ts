// Pure date-range lookups against school_years — no stored FK on
// calendar_events/attendance_sessions (product decision: a row's school year
// is derived from its own date, not tracked separately, so there's nothing to
// keep in sync). This is the single implementation of "which year does this
// date fall in"; src/lib/reports/aggregate.ts's quarterBoundsFor uses it too
// rather than duplicating the lookup.

import type { SchoolYear } from "../reports/types";

export function findSchoolYearForDate(dateIso: string, schoolYears: SchoolYear[]): SchoolYear | null {
  return schoolYears.find((y) => y.start_date <= dateIso && dateIso <= y.end_date) ?? null;
}

// "The active school year" = whichever non-archived year's range contains
// today. Archived years are excluded here (they shouldn't appear as "active"
// even if their dates happen to span today), but findSchoolYearForDate itself
// still matches archived years for historical lookups (e.g. reports
// bucketing a past date into an archived year).
export function getActiveSchoolYear(schoolYears: SchoolYear[], today: Date = new Date()): SchoolYear | null {
  const todayIso = today.toISOString().slice(0, 10);
  return findSchoolYearForDate(todayIso, schoolYears.filter((y) => !y.archived));
}
