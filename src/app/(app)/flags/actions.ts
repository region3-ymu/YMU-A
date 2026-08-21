"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { describeReasonGap } from "@/lib/attendance/flag-reasons";

export type ResolveFlagState = { error?: string } | undefined;
export type ForceCloseState = { error?: string } | undefined;

export async function resolveFlag(
  _prev: ResolveFlagState,
  formData: FormData,
): Promise<ResolveFlagState> {
  // Authoritative check; resolve_flag() re-enforces the role/region rule in SQL.
  await requireRole(...MANAGER_ROLES);

  const flagId = String(formData.get("flag_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const notes = String(formData.get("reason_notes") ?? "").trim();
  if (!flagId) return { error: "No flag selected." };

  // This is the argument that used to go missing. resolve_flag has taken
  // p_notes since 0012 and this action never passed it, so every "Mark
  // resolved" wrote resolution_notes: null — 44 of the first 93 resolved flags
  // have no reason on record because of these two lines, not because nobody
  // typed one.
  const gap = describeReasonGap(reason, notes);
  if (gap) return { error: gap };

  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_flag", {
    p_flag_id: flagId,
    p_reason: reason,
    p_notes: notes || null,
  });
  if (error) return { error: error.message };

  revalidatePath("/flags");
  // The dashboard shows the same escalations from two angles (Late clock-ins,
  // Missing clock-ins today). Resolving here has to clear both, or the item
  // reappears the moment the manager navigates back.
  revalidatePath("/dashboard");
  return undefined;
}

// Tighter than resolveFlag's MANAGER_ROLES — force-closing an attendance
// record without the teacher's real answers is a higher-stakes action than
// resolving an escalation card, so it's OM/CPO only. admin_close_stuck_session
// re-enforces this in SQL regardless of what the UI offers.
export async function forceCloseStuckSession(
  _prev: ForceCloseState,
  formData: FormData,
): Promise<ForceCloseState> {
  await requireRole("operations_manager", "cpo");

  const sessionId = String(formData.get("session_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!sessionId) return { error: "No session selected." };
  if (!reason) return { error: "A reason is required to force-close a session." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_close_stuck_session", {
    p_session_id: sessionId,
    p_reason: reason,
  });
  if (error) return { error: error.message };

  revalidatePath("/flags");
  revalidatePath("/dashboard");
  return undefined;
}
