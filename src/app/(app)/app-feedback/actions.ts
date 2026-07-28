"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/dal";
import { canViewAppFeedback } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type SubmitFeedbackState = { error?: string; success?: boolean } | undefined;
export type ResolveAppFeedbackState = { error?: string } | undefined;

// The screenshot (if any) is uploaded client-side directly to the
// 'app-feedback' storage bucket first (storage RLS requires the path to
// start with the uploader's own uid — see migration 0024); this action only
// ever receives the resulting path string, never the file itself.
export async function submitAppFeedback(
  _prev: SubmitFeedbackState,
  formData: FormData,
): Promise<SubmitFeedbackState> {
  const profile = await requireProfile();

  const message = String(formData.get("message") ?? "").trim();
  const pagePath = String(formData.get("page_path") ?? "");
  const screenshotPath = String(formData.get("screenshot_path") ?? "") || null;
  const deviceInfoRaw = String(formData.get("device_info") ?? "");
  if (!message) return { error: "Please describe what's failing." };

  let deviceInfo: unknown = null;
  try {
    deviceInfo = deviceInfoRaw ? JSON.parse(deviceInfoRaw) : null;
  } catch {
    deviceInfo = null;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("app_feedback").insert({
    submitted_by: profile.id,
    submitted_by_role: profile.role,
    page_path: pagePath,
    message,
    screenshot_path: screenshotPath,
    device_info: deviceInfo,
  });
  if (error) return { error: error.message };

  return { success: true };
}

export async function resolveAppFeedback(
  _prev: ResolveAppFeedbackState,
  formData: FormData,
): Promise<ResolveAppFeedbackState> {
  const profile = await requireProfile();
  if (!canViewAppFeedback(profile.role, profile.is_app_admin)) {
    return { error: "Not authorized." };
  }

  const feedbackId = String(formData.get("feedback_id") ?? "");
  if (!feedbackId) return { error: "No report selected." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("app_feedback")
    .update({ resolved_at: new Date().toISOString(), resolved_by: profile.id })
    .eq("id", feedbackId);
  if (error) return { error: error.message };

  revalidatePath("/app-feedback");
  return undefined;
}
