// Server-side reads for the clocking flow, shared by the Clocking tab, the
// Feedback route, and the home re-prompt. All are RLS-scoped to the caller:
// a teacher only ever sees their own sessions and their own matched classes.

import { createClient } from "@/lib/supabase/server";
import type { AttendanceStatus } from "@/lib/attendance/status";

export type ClockSchool = {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  geofence_radius_m: number;
};

export type OpenSession = {
  id: string;
  event_id: string | null;
  school_id: string | null;
  clock_in_at: string;
  clock_in_status: AttendanceStatus;
  scheduled_start_at: string | null;
  event: { id: string; summary: string | null; start_at: string | null; end_at: string | null } | null;
  school: ClockSchool | null;
};

export type NextClass = {
  id: string;
  summary: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  school: ClockSchool | null;
};

const SCHOOL_COLUMNS = "id, name, address, lat, lng, geofence_radius_m";

// The caller's currently-open session (clocked in, feedback not yet
// submitted), or null. An open session IS the blocking feedback obligation.
export async function getOpenSession(): Promise<OpenSession | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select(
      `id, event_id, school_id, clock_in_at, clock_in_status, scheduled_start_at,
       event:calendar_events(id, summary, start_at, end_at),
       school:schools(${SCHOOL_COLUMNS})`,
    )
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as unknown as OpenSession) ?? null;
}

// The soonest matched class the caller can still clock into (not yet ended,
// not cancelled, matched to a school). null when there's nothing upcoming.
export async function getNextClass(): Promise<NextClass | null> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("calendar_events")
    .select(`id, summary, start_at, end_at, all_day, school:schools(${SCHOOL_COLUMNS})`)
    .neq("status", "cancelled")
    .eq("all_day", false)
    .not("school_id", "is", null)
    .gte("end_at", nowIso)
    .order("start_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as unknown as NextClass) ?? null;
}
