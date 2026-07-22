// Search across calendar events, attendance records, and schools/teachers —
// every query below runs through the caller's own RLS-scoped server client,
// so a teacher's search only ever surfaces their own rows and a Regional
// Manager's only surfaces their region's, exactly like every other read in
// this app. No new grants, no SECURITY DEFINER — this is a convenience
// layer over data the caller could already read one table at a time.

import { createClient } from "@/lib/supabase/server";

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

  const [eventsRes, schoolsRes, teachersRes] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("id, summary, start_at, school:schools(name)")
      .neq("status", "cancelled")
      .or(`summary.ilike.${pattern},location_raw.ilike.${pattern}`)
      .order("start_at", { ascending: false })
      .limit(20),
    supabase.from("schools").select("id, name").ilike("name", pattern).limit(10),
    supabase.from("profiles").select("id, full_name").eq("role", "teacher").ilike("full_name", pattern).limit(10),
  ]);

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
  const matchedTeacherIds = ((teachersRes.data as Array<{ id: string; full_name: string }>) ?? []).map(
    (t) => t.id,
  );

  const sessionSelect =
    "id, clock_in_at, clock_out_at, clock_in_status, teacher:profiles!attendance_sessions_teacher_id_fkey(full_name), school:schools(name)";

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
    clock_in_at: string;
    clock_out_at: string | null;
    clock_in_status: "on_time" | "late";
    teacher: { full_name: string } | null;
    school: { name: string } | null;
  };

  const byId = new Map<string, SessionResult>();
  for (const raw of [
    ...((sessionsByTeacherRes.data as unknown as RawSession[]) ?? []),
    ...((sessionsByNotesRes.data as unknown as RawSession[]) ?? []),
  ]) {
    byId.set(raw.id, {
      id: raw.id,
      teacher_name: raw.teacher?.full_name ?? "Unknown teacher",
      school_name: raw.school?.name ?? null,
      clock_in_at: raw.clock_in_at,
      clock_out_at: raw.clock_out_at,
      clock_in_status: raw.clock_in_status,
    });
  }

  return { events, schools, sessions: Array.from(byId.values()) };
}
