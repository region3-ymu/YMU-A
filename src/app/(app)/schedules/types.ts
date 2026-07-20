import type { AppRole, Region } from "@/lib/auth/roles";

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
  reason: "no_matching_school" | "ambiguous_match" | "school_already_linked" | "sync_error";
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

export type ScheduleEvent = {
  id: string;
  summary: string | null;
  description: string | null;
  location_raw: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  status: string;
  html_link: string | null;
  organizer_email: string | null;
  attendees: ScheduleAttendee[];
  teacher_ids: string[];
  school_id: string | null;
  school_match_score: number | null;
  school_match_source: "fuzzy" | "manual" | null;
  raw: Record<string, unknown> | null;
  school: ScheduleSchool | null;
};

export type SchedulesExplorerProps = {
  events: ScheduleEvent[];
  schools: ScheduleSchool[];
  calendarIssues: CalendarSyncIssue[];
  callerRole: AppRole;
  now: string;
};
