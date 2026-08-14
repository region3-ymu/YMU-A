// When this app's data starts.
//
// The pilot went live on 13 August 2026. Everything before that date in the
// database is Google Calendar history that got swept in by the initial sync —
// 8,496 events from the previous school year and the summer. No teacher ever
// clocked into one, so every one of them counts as a missed class, and they
// swamped the reports: a Regional Manager's "last 30 days" was mostly July.
//
// There is nothing else to filter. Attendance, feedback, flags and tickets all
// begin on or after this date; only calendar_events reaches back.
//
// SQL is authoritative — public.app_data_start() (migration 0049) is what
// actually bounds attendance_period_rows, so nothing can reach behind this
// date whatever a caller asks for. This constant is its twin for the UI, the
// same arrangement FEEDBACK_WINDOW_HOURS has with has_overdue_feedback(). Keep
// the two in step; if they ever disagree, SQL wins and the UI is the bug.

/** ISO date, America/New_York calendar day. */
export const DATA_START_DATE = "2026-08-13";

/** The same instant as an ISO string, for query bounds. */
export const DATA_START_ISO = `${DATA_START_DATE}T00:00:00.000Z`;

/**
 * `from` bound, never earlier than the day the data starts.
 *
 * Undefined in means "no lower bound", which becomes the data start rather
 * than the beginning of time — that is what "All time" should mean here.
 */
export function clampToDataStart(from?: string): string {
  if (!from) return DATA_START_ISO;
  return from < DATA_START_ISO ? DATA_START_ISO : from;
}
