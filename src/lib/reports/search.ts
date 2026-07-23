// Search across calendar events, attendance records, and schools/teachers —
// every query below runs through the caller's own RLS-scoped server client,
// so a teacher's search only ever surfaces their own rows and a Regional
// Manager's only surfaces their region's, exactly like every other read in
// this app. No new grants — the one exception is teacher name resolution,
// which goes through getReportRoster() (SECURITY DEFINER) rather than a
// plain `profiles` select/embed: a Regional Manager's profiles_select RLS
// gates on profiles.region, which is null-by-design for teachers (Phase 3
// derives a teacher's region from their scheduled schools instead), so a
// direct profiles read here would silently return zero teacher matches for
// every Regional Manager. getReportRoster() scopes correctly instead
// (calendar_events -> schools.region), same fix as the dashboard and /flags.

import { createClient } from "@/lib/supabase/server";
import { getReportRoster } from "./queries";

export type EventResult = {
  id: string;
  summary: string | null;
  start_at: string | null;
  school_name: string | null;
};

export type SessionResult = {
  id: string;
  teacher_name: string;
  school_name: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  clock_in_status: "on_time" | "late";
};

export type SchoolResult = { id: string; name: string };

export type SearchResults = {
  events: EventResult[];
  sessions: SessionResult[];
  schools: SchoolResult[];
};

const EMPTY: SearchResults = { events: [], sessions: [], schools: [] };

export async function searchAll(rawQuery: string): Promise<SearchResults> {
  const term = rawQuery.trim();
  if (term.length < 2) return EMPTY;
  const pattern = `%${term}%`;
  const supabase = await createClient();

  const [eventsRes, schoolsRes, roster] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("id, summary, start_at, school:schools(name)")
      .neq("status", "cancelled")
      .or(`summary.ilike.${pattern},location_raw.ilike.${pattern}`)
      .order("start_at", { ascending: false })
      .limit(20),
    supabase.from("schools").select("id, name").ilike("name", pattern).limit(10),
    // includeArchived: true — search should still find an archived teacher's
    // historical sessions, matching this function's pre-fix behavior (the
    // old direct profiles select had no archived filter at all).
    getReportRoster(true),
  ]);
  const nameById = new Map(roster.map((t) => [t.id, t.full_name]));

  const events: EventResult[] = ((eventsRes.data as unknown as Array<{
    id: string;
    summary: string | null;
    start_at: string | null;
    school: { name: string } | null;
  }>) ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start_at: e.start_at,
    school_name: e.school?.name ?? null,
  }));

  const schools: SchoolResult[] = (schoolsRes.data as SchoolResult[]) ?? [];
  const lowerTerm = term.toLowerCase();
  const matchedTeacherIds = roster
    .filter((t) => t.full_name.toLowerCase().includes(lowerTerm))
    .map((t) => t.id);

  const sessionSelect = "id, teacher_id, clock_in_at, clock_out_at, clock_in_status, school:schools(name)";

  const [sessionsByTeacherRes, sessionsByNotesRes] = await Promise.all([
    matchedTeacherIds.length > 0
      ? supabase
          .from("attendance_sessions")
          .select(sessionSelect)
          .in("teacher_id", matchedTeacherIds)
          .order("clock_in_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] as unknown[] }),
    supabase
      .from("attendance_sessions")
      .select(sessionSelect)
      .or(`feedback_notes.ilike.${pattern},feedback_engagement.ilike.${pattern}`)
      .order("clock_in_at", { ascending: false })
      .limit(20),
  ]);

  type RawSession = {
    id: string;
    teacher_id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    clock_in_status: "on_time" | "late";
    school: { name: string } | null;
  };

  const byId = new Map<string, SessionResult>();
  for (const raw of [
    ...((sessionsByTeacherRes.data as unknown as RawSession[]) ?? []),
    ...((sessionsByNotesRes.data as unknown as RawSession[]) ?? []),
  ]) {
    byId.set(raw.id, {
      id: raw.id,
      teacher_name: nameById.get(raw.teacher_id) ?? "Unknown teacher",
      school_name: raw.school?.name ?? null,
      clock_in_at: raw.clock_in_at,
      clock_out_at: raw.clock_out_at,
      clock_in_status: raw.clock_in_status,
    });
  }

  return { events, schools, sessions: Array.from(byId.values()) };
}
