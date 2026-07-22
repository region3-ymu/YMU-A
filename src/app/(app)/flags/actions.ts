"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type ResolveFlagState = { error?: string } | undefined;
export type ForceCloseState = { error?: string } | undefined;

export async function resolveFlag(
  _prev: ResolveFlagState,
  formData: FormData,
): Promise<ResolveFlagState> {
  // Authoritative check; resolve_flag() re-enforces the role/region rule in SQL.
  await requireRole(...MANAGER_ROLES);

  const flagId = String(formData.get("flag_id") ?? "");
  if (!flagId) return { error: "No flag selected." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_flag", { p_flag_id: flagId });
  if (error) return { error: error.message };

  revalidatePath("/flags");
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
  return undefined;
}
