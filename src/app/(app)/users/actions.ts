"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import {
  assignableRoles,
  canAssignOperationsManager,
  canManageTeam,
  isAppRole,
  isRegion,
  type AppRole,
} from "@/lib/auth/roles";
import { createAdminClient } from "@/lib/supabase/admin";
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
  if (target.role === "operations_manager" && !canAssignOperationsManager(callerRole)) {
    return { error: "Only the CPO or an administrator can archive an Operations Manager." };
  }
  return null;
}

/**
 * The /users guard, for every action on this page.
 *
 * Mirrors current_can_manage_team() (migration 0069). Every action below is
 * still re-checked in SQL — by promote_user(), by profiles_update_admin, and by
 * the protect_privileged_profile_columns trigger — except createAccount(),
 * which cannot be: minting an auth user needs the service-role key, and the
 * service role has no RLS to be checked against. That one call is why this
 * guard has to be exactly right.
 */
async function requireTeamAdmin() {
  const profile = await requireProfile();
  if (!canManageTeam(profile.role, profile.is_app_admin)) redirect("/");
  return profile;
}

export type CreateAccountState =
  | { error?: string; success?: string }
  | undefined;

const MIN_TEMP_PASSWORD = 8;

/**
 * Create somebody's account outright, rather than waiting for them to sign up.
 *
 * Until now /users could only re-role an account that already existed, so
 * adding a person meant asking them to find the signup page first and then
 * chasing them to confirm they had. YMU asked for it to work the other way
 * round (2026-08-18).
 *
 * email_confirm: true because the alternative is a confirmation mail the new
 * person has to act on before the account works at all — the exact round trip
 * this is meant to remove. The temporary password is the admin's to pass along,
 * and Settings already has a change-password form for the other end.
 *
 * The auth user is deleted again if the role assignment fails. There is no
 * transaction spanning auth.users and a SECURITY DEFINER call, so without that
 * a rejected role would leave a live account silently sitting at the default
 * 'teacher' — the one failure mode here that is worse than an error message.
 */
export async function createAccount(
  _prev: CreateAccountState,
  formData: FormData,
): Promise<CreateAccountState> {
  const caller = await requireTeamAdmin();

  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = formData.get("role");
  const regionRaw = formData.get("region");

  if (!fullName) return { error: "Enter the person's full name." };
  // Deliberately shallow. Anything stricter rejects real addresses, and the
  // authoritative check is auth.admin.createUser refusing it below.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < MIN_TEMP_PASSWORD) {
    return { error: `The temporary password must be at least ${MIN_TEMP_PASSWORD} characters.` };
  }
  if (!isAppRole(role) || !assignableRoles(caller.role).includes(role)) {
    return { error: "Pick a role you're allowed to assign." };
  }
  const region = role === "regional_manager" ? regionRaw : null;
  if (role === "regional_manager" && !isRegion(region)) {
    return { error: "Pick a region for the Regional Manager." };
  }

  const admin = createAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // handle_new_user() reads both out of raw_user_meta_data to build the
    // profile row, so this is what names the person on every screen.
    user_metadata: { full_name: fullName, phone: phone || null },
  });
  if (createError || !created.user) {
    const message = createError?.message ?? "Could not create that account.";
    return {
      error: /already|registered|exists/i.test(message)
        ? "Someone already has an account with that email."
        : message,
    };
  }

  // As the caller, not as the admin client: promote_user() is where the role
  // rules live, and running it under the service role would skip them.
  if (role !== "teacher") {
    const supabase = await createClient();
    const { error: roleError } = await supabase.rpc("promote_user", {
      target_id: created.user.id,
      new_role: role,
      new_region: region,
    });
    if (roleError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return { error: `Account not created: ${roleError.message}` };
    }
  }

  revalidatePath("/users");
  return { success: `${fullName} can now sign in as ${email}.` };
}

export async function promoteUser(
  _prev: PromoteFormState,
  formData: FormData,
): Promise<PromoteFormState> {
  // Authoritative check; the promote_user RPC re-enforces all of this in SQL.
  const caller = await requireTeamAdmin();

  const targetId = String(formData.get("target_id") ?? "");
  const role = formData.get("role");
  const regionRaw = formData.get("region");

  if (!targetId || !isAppRole(role) || !assignableRoles(caller.role).includes(role)) {
    return { error: "Invalid role selection." };
  }
  if (role === "operations_manager" && !canAssignOperationsManager(caller.role)) {
    return { error: "Only the CPO or an administrator can promote to Operations Manager." };
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
  const caller = await requireTeamAdmin();
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
  const caller = await requireTeamAdmin();
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

/**
 * Excuse a teacher from clocking in — or put them back on it.
 *
 * Only ever meaningful for a teacher: managers do not clock in at all. The
 * profiles_protect_privileged_columns trigger re-enforces the OM/CPO rule in
 * SQL, which matters because profiles_update_own would otherwise let a teacher
 * exempt themselves.
 */
export async function setClockInExempt(
  _prev: ArchiveFormState,
  formData: FormData,
): Promise<ArchiveFormState> {
  const caller = await requireTeamAdmin();
  const targetId = String(formData.get("target_id") ?? "");
  const exempt = String(formData.get("exempt") ?? "") === "yes";

  const guardError = await guardArchiveTarget(caller.id, caller.role, targetId);
  if (guardError) return guardError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ clock_in_exempt: exempt })
    .eq("id", targetId)
    .eq("role", "teacher");
  if (error) return { error: error.message };

  revalidatePath("/users");
  revalidatePath("/dashboard");
  return {
    success: exempt
      ? "Excused from clocking in. Their classes will be recorded automatically once each one ends."
      : "Back on the normal clock-in flow.",
  };
}
