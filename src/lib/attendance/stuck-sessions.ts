// Reads for the "Zoho webhook never arrived" reliability path (Phase 9).
// Mirrors dashboard/queries.ts's getOpenLateFlags() shape — an open
// feedback_stuck flag IS the thing both /flags (action) and the dashboard
// (visibility) need to read, same as late_clock_in flags already work.

import { createClient } from "@/lib/supabase/server";

export type StuckSessionFlag = {
  id: string;
  session_id: string;
  created_at: string;
  details: Record<string, unknown>;
  teacher: { id: string; full_name: string; phone: string | null } | null;
  school: { id: string; name: string } | null;
  event: { id: string; summary: string | null } | null;
  session: { id: string; clock_in_at: string } | null;
};

const STUCK_SESSION_FLAG_COLUMNS = `
  id, session_id, created_at, details,
  teacher:profiles!flags_teacher_id_fkey(id, full_name, phone),
  school:schools(id, name),
  event:calendar_events(id, summary),
  session:attendance_sessions(id, clock_in_at)
`;

export async function getStuckSessionFlags(): Promise<StuckSessionFlag[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("flags")
    .select(STUCK_SESSION_FLAG_COLUMNS)
    .eq("type", "feedback_stuck")
    .is("resolved_at", null)
    .order("created_at", { ascending: false });
  return (data as unknown as StuckSessionFlag[]) ?? [];
}
