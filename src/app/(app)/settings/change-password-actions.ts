"use server";

import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

export type ChangePasswordState = { error?: string; ok?: boolean } | undefined;

/**
 * Change your own password from Settings.
 *
 * Separate from `updatePassword` in (auth)/actions.ts, which serves the
 * recovery-email flow and redirects home on success. Here the caller is
 * already signed in and stays on the page, so this returns a state instead —
 * a redirect out of Settings after changing a password reads like something
 * went wrong.
 *
 * The caller re-enters their CURRENT password, verified client-side with a
 * fresh signInWithPassword() before this runs — the same split
 * AdminEditAttendanceForm has used since 0023. Supabase has no
 * "verify password" primitive, and the check needs a password the user just
 * typed, so it cannot happen here. This layer re-checks the session and the
 * new password's shape, which is what it can actually enforce.
 *
 * Why require the current password at all, when the recovery flow cannot: an
 * unlocked phone left on a desk is the realistic threat for a teacher's
 * account, and without it, taking one over needs no secret at all.
 */
export async function changePassword(
  _previous: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  await requireProfile();

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (password !== confirm) return { error: "The two passwords don't match." };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };

  return { ok: true };
}
