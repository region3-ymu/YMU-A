// Reads for the "Zoho webhook never arrived" reliability path (Phase 9).
// Mirrors dashboard/queries.ts's getOpenLateFlags() shape — an open
// feedback_stuck flag IS the thing both /flags (action) and the dashboard
// (visibility) need to read, same as late_clock_in flags already work.

import { createClient } from "@/lib/supabase/server";

export type StuckSessionFlag = {
  id: string;
  session_id: string;
  teacher_id: string;
  created_at: string;
  details: Record<string, unknown>;
  school: { id: string; name: string } | null;
  event: { id: string; summary: string | null } | null;
  session: { id: string; clock_in_at: string } | null;
};

// No profiles(full_name/phone) embed — see the comment in
// dashboard/queries.ts's getOpenSessions() for why that silently breaks for
// Regional Managers. Callers resolve teacher name/phone via getReportRoster().
const STUCK_SESSION_FLAG_COLUMNS = `
  id, session_id, teacher_id, created_at, details,
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
