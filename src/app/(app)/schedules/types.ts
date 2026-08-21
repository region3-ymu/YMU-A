import type { AppRole, Region } from "@/lib/auth/roles";
import type { ScheduleRangeKey } from "@/lib/schedules/range";

export type ScheduleSchool = {
  id: string;
  name: string;
  address: string;
  region: Region | null;
  google_calendar_id?: string | null;
};

export type CalendarSyncIssueCandidate = { school_id: string; school_name: string; score: number };

export type CalendarSyncIssue = {
  id: string;
  calendar_id: string;
  calendar_summary: string | null;
  reason:
    | "no_matching_school"
    | "ambiguous_match"
    | "school_already_linked"
    | "level_mismatch"
    | "sync_error";
  candidates: CalendarSyncIssueCandidate[];
  detected_at: string;
};

export type ScheduleAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
};

/**
 * What the Schedules LIST needs, and nothing more.
 *
 * Deliberately narrow. The list used to select the full row including `raw`
 * and `attendees`: for the ~7,000 events it was fetching that came to roughly
 * 9.4 MB, of which `raw` alone was 85-90% — all of it serialized into the RSC
 * payload for a list that renders a title, a time and a school name. Fields
 * only the detail page reads live on ScheduleEventDetail below.
 */
export type ScheduleEvent = {
  id: string;
  summary: string | null;
  location_raw: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  status: string;
  teacher_ids: string[];
  school_id: string | null;
  school: ScheduleSchool | null;
};

/** The single-event page, which really does use the whole row. */
export type ScheduleEventDetail = ScheduleEvent & {
  description: string | null;
  html_link: string | null;
  organizer_email: string | null;
  attendees: ScheduleAttendee[];
  school_match_score: number | null;
  school_match_source: "fuzzy" | "manual" | null;
  raw: Record<string, unknown> | null;
};

/** Columns behind ScheduleEvent — shared by the list query and its type. */
export const SCHEDULE_LIST_COLUMNS =
  "id, summary, location_raw, start_at, end_at, all_day, status, teacher_ids, school_id, " +
  "school:schools(id, name, address, region)";

export const SCHEDULE_DETAIL_COLUMNS =
  `${SCHEDULE_LIST_COLUMNS}, description, html_link, organizer_email, attendees, ` +
  "school_match_score, school_match_source, raw";

export type SchedulesExplorerProps = {
  events: ScheduleEvent[];
  schools: ScheduleSchool[];
  calendarIssues: CalendarSyncIssue[];
  callerRole: AppRole;
  now: string;
  range: ScheduleRangeKey;
  rangeOptions: { key: ScheduleRangeKey; label: string }[];
};

/**
 * One same-teacher same-school run where the next class starts within 30
 * minutes of the previous one ending. Shape of back_to_back_runs() in
 * migration 0077.
 *
 * There are 23 of these across the four regions and they are the source of 20
 * of the first 116 late-clock-in flags — the teacher is standing in the room
 * they clocked into ninety minutes earlier. `late_flags` and `occurrences` are
 * on the row so the decision to suppress a clock-in is made against evidence
 * rather than from memory.
 */
export type BackToBackRun = {
  school_id: string;
  school_name: string;
  region: Region | null;
  teacher_id: string | null;
  teacher_name: string | null;
  first_class: string | null;
  first_start: string;
  first_end: string;
  second_class: string | null;
  second_start: string;
  gap_minutes: number;
  is_afterschool: boolean;
  occurrences: number;
  late_flags: number;
  rule_active: boolean;
};
