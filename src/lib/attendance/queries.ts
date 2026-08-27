// Server-side reads for the clocking flow, shared by the Clocking tab, the
// Feedback route, and the home re-prompt. All are RLS-scoped to the caller:
// a teacher only ever sees their own sessions and their own matched classes.

import { createClient } from "@/lib/supabase/server";
import type { SessionStatus } from "@/lib/attendance/status";
import { startOfLocalDay } from "@/lib/schedules/range";

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
  clock_in_status: SessionStatus;
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

// A class the caller still owes feedback for. Since migration 0026 this is no
// longer the same thing as an open session: clock-out and feedback are
// separate, and a settled-but-not-clocked-out row (or vice versa) is normal.
export type OwedFeedback = {
  id: string;
  event_id: string | null;
  clock_in_at: string;
  clock_in_status: SessionStatus;
  clock_out_at: string | null;
  scheduled_end_at: string | null;
  feedback_due_at: string | null;
  event: { summary: string | null; start_at: string | null; end_at: string | null } | null;
  school: { name: string } | null;
};

// The caller's currently-open session — "am I clocked in right now". Since
// 0026 this no longer implies feedback is owed; use getFeedbackOwed() for
// that. GPS sampling and the Clock out button key off this one.
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

// Every class the caller still owes feedback for, soonest deadline first.
// RLS scopes attendance_sessions to the caller's own rows, so this is exactly
// "my outstanding feedback". Backs both /feedback (the list) and the home
// banner; the overdue count is derived from the result rather than costing a
// second round-trip.
export async function getFeedbackOwed(): Promise<OwedFeedback[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select(
      `id, event_id, clock_in_at, clock_in_status, clock_out_at, scheduled_end_at, feedback_due_at,
       event:calendar_events(summary, start_at, end_at),
       school:schools(name)`,
    )
    .is("feedback_settled_at", null)
    .order("feedback_due_at", { ascending: true, nullsFirst: false });
  return (data as unknown as OwedFeedback[]) ?? [];
}

// One owed item by id, for /feedback/[sessionId]. Returns null when the id
// isn't the caller's or its feedback is already in — RLS handles the former,
// the filter the latter, so a stale link renders "nothing to do" rather than
// letting someone submit twice.
export async function getOwedFeedbackById(sessionId: string): Promise<OwedFeedback | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select(
      `id, event_id, clock_in_at, clock_in_status, clock_out_at, scheduled_end_at, feedback_due_at,
       event:calendar_events(summary, start_at, end_at),
       school:schools(name)`,
    )
    .eq("id", sessionId)
    .is("feedback_settled_at", null)
    .maybeSingle();
  return (data as unknown as OwedFeedback) ?? null;
}

// The soonest matched class the caller can still clock into TODAY (not yet
// ended, not cancelled, matched to a school, and not already attended). null
// when there is nothing left today.
//
// Same-day is the point. A teacher with classes today and tomorrow could
// previously clock into TOMORROW's class today, which invents attendance for a
// class that has not happened. clock_in() rejects it outright now (migration
// 0032); this stops the app from offering it in the first place.
//
// "Today" is the Miami calendar day, not UTC: an 8:30 PM Miami class is 00:30
// UTC the NEXT day, and a UTC comparison would hide a teacher's own evening
// class from them. Tomorrow's class appears on its own at Miami midnight.
export async function getNextClass(): Promise<NextClass | null> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const todayMiami = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  // Classes the caller has ALREADY clocked into (open OR closed) must not be
  // re-offered. Without this, a teacher who clocked in and submitted feedback
  // for a class that hadn't ended yet saw that same class pop back up offering
  // another clock-in — clocking in again started a second session, so
  // finishing feedback just looped them straight back to "clock in" once more
  // (reported live during the relay: "the shift keeps running, it asks me to
  // clock in again"). RLS scopes attendance_sessions to the caller's own rows,
  // so this is exactly "events I personally already have a session for".
  const { data: sessions } = await supabase
    .from("attendance_sessions")
    .select("event_id")
    .not("event_id", "is", null);
  const attended = new Set(
    (sessions ?? [])
      .map((s) => (s as { event_id: string | null }).event_id)
      .filter((v): v is string => Boolean(v)),
  );

  // Pull the soonest handful of still-clockable classes, then pick the first
  // the caller hasn't already attended. Filtering in JS (rather than a dynamic
  // NOT IN on the query) keeps Supabase's generics from blowing up and a
  // teacher never has anywhere near this many overlapping upcoming classes.
  const { data } = await supabase
    .from("calendar_events")
    .select(`id, summary, start_at, end_at, all_day, school:schools(${SCHOOL_COLUMNS})`)
    .neq("status", "cancelled")
    .eq("all_day", false)
    .not("school_id", "is", null)
    .gte("end_at", nowIso)
    .order("start_at", { ascending: true })
    .limit(50);
  const candidates = (data as unknown as NextClass[] | null) ?? [];
  const isToday = (startAt: string | null) =>
    startAt != null
    && new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(startAt)) === todayMiami;

  return candidates.find((event) => !attended.has(event.id) && isToday(event.start_at)) ?? null;
}

/**
 * Classes today the caller should already have clocked into and hasn't.
 *
 * Counts a class from the moment it starts, not from the moment it ends —
 * "you're in the room and haven't clocked in" is exactly the window where a
 * reminder can still change the outcome, and attendance_period_rows only
 * reports 'missed' once the class is over and it is too late to fix.
 *
 * Feeds the home-screen app badge, which is the one insistent channel iOS
 * leaves open to a web app.
 */
export async function getUnclockedClassCount(): Promise<number> {
  const supabase = await createClient();
  // The Miami day, not the server's and not UTC's — a teacher opening this at
  // 8pm should still be counted against today's classes.
  const dayStart = startOfLocalDay();
  const now = Date.now();
  const { data, error } = await supabase
    .from("attendance_period_rows")
    .select("event_id")
    .is("session_id", null)
    .gte("start_at", new Date(dayStart).toISOString())
    .lt("start_at", new Date(dayStart + 24 * 60 * 60 * 1000).toISOString())
    .lte("start_at", new Date(now).toISOString());
  if (error) {
    console.error(`[attendance] unclocked class count failed: ${error.message}`);
    return 0;
  }
  return (data ?? []).length;
}
