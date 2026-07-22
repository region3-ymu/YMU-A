"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { isAppRole, isRegion, type AppRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type PromoteFormState =
  | { error?: string; success?: string }
  | undefined;

export type ArchiveFormState = { error?: string; success?: string } | undefined;

// Mirrors users/page.tsx's assignableRoles gate (self/cpo/OM-by-OM are
// never valid targets) — the UI already hides the button for these, this is
// the server-side backstop.
async function guardArchiveTarget(
  callerId: string,
  callerRole: AppRole,
  targetId: string,
): Promise<{ error: string } | null> {
  if (!targetId) return { error: "Invalid target." };
  if (targetId === callerId) return { error: "You can't archive your own account." };

  const supabase = await createClient();
  const { data: target, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", targetId)
    .single();
  if (error || !target) return { error: "Teacher not found." };
  if (target.role === "cpo") return { error: "The CPO account can't be archived." };
  if (target.role === "operations_manager" && callerRole !== "cpo") {
    return { error: "Only the CPO can archive an Operations Manager." };
  }
  return null;
}

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

export async function archiveTeacher(
  _prev: ArchiveFormState,
  formData: FormData,
): Promise<ArchiveFormState> {
  const caller = await requireRole("operations_manager", "cpo");
  const targetId = String(formData.get("target_id") ?? "");

  const guardError = await guardArchiveTarget(caller.id, caller.role, targetId);
  if (guardError) return guardError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) return { error: error.message };

  revalidatePath("/users");
  return { success: "Account archived." };
}

export async function unarchiveTeacher(
  _prev: ArchiveFormState,
  formData: FormData,
): Promise<ArchiveFormState> {
  const caller = await requireRole("operations_manager", "cpo");
  const targetId = String(formData.get("target_id") ?? "");

  const guardError = await guardArchiveTarget(caller.id, caller.role, targetId);
  if (guardError) return guardError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ archived_at: null })
    .eq("id", targetId);
  if (error) return { error: error.message };

  revalidatePath("/users");
  return { success: "Account unarchived." };
}
