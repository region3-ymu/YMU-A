"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { isAppRole, isRegion } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type PromoteFormState =
  | { error?: string; success?: string }
  | undefined;

export async function promoteUser(
  _prev: PromoteFormState,
  formData: FormData,
): Promise<PromoteFormState> {
  // Authoritative check; the promote_user RPC re-enforces all of this in SQL.
  const caller = await requireRole("operations_manager", "cpo");

  const targetId = String(formData.get("target_id") ?? "");
  const role = formData.get("role");
  const regionRaw = formData.get("region");

  if (!targetId || !isAppRole(role) || role === "cpo") {
    return { error: "Invalid role selection." };
  }
  if (role === "operations_manager" && caller.role !== "cpo") {
    return { error: "Only the CPO can promote to Operations Manager." };
  }
  const region = role === "regional_manager" ? regionRaw : null;
  if (role === "regional_manager" && !isRegion(region)) {
    return { error: "Pick a region for the Regional Manager." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("promote_user", {
    target_id: targetId,
    new_role: role,
    new_region: region,
  });
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/users");
  return { success: "Role updated." };
}
