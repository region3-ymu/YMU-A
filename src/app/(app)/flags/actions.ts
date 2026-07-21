"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type ResolveFlagState = { error?: string } | undefined;

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
