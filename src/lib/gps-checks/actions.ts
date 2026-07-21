// Client-side sampling of due gps_checks. Called from the always-mounted
// GpsCheckSampler (src/components/gps-check-sampler.tsx) — never rendered as
// its own page, so there's no UI here, only the RLS-scoped reads/RPC calls a
// teacher's own browser session is allowed to make.

import { createClient } from "@/lib/supabase/client";

export type DueCheck = { id: string };

// The caller's own open session, if any. Managers/teachers with no open
// session just get null (RLS already scopes this to the caller's own rows).
export async function getOwnOpenSessionId(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("attendance_sessions")
    .select("id")
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// Pending checks for a session whose due time has already passed — these are
// the ones worth sampling right now.
export async function getDueChecks(sessionId: string): Promise<DueCheck[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("gps_checks")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .lte("due_at", new Date().toISOString());
  return data ?? [];
}

export async function recordGpsCheck(
  checkId: string,
  lat: number,
  lng: number,
  accuracyM: number | null,
): Promise<void> {
  const supabase = createClient();
  await supabase.rpc("record_gps_check", {
    p_check_id: checkId,
    p_lat: lat,
    p_lng: lng,
    p_accuracy_m: accuracyM,
  });
}
