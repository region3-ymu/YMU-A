import type { AppRole, Region } from "@/lib/auth/roles";

export type ScheduleSchool = {
  id: string;
  name: string;
  address: string;
  region: Region | null;
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
  callerRole: AppRole;
  now: string;
};
