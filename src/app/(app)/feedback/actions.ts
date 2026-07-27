"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

export type RelayFeedbackState = { error?: string } | undefined;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Submits this week's native "relay" feedback form and closes the session in
// one authenticated RPC call (close_session_with_relay_feedback, migration
// 0022) — no external relay, no webhook, matching this app's original
// pre-Zoho-rework clock_out_with_feedback shape (see DECISIONS.md).
export async function submitRelayFeedback(
  _previous: RelayFeedbackState,
  formData: FormData,
): Promise<RelayFeedbackState> {
  await requireRole("teacher");

  const sessionId = String(formData.get("session_id") ?? "");
  if (!isUuid(sessionId)) return { error: "No open session found." };

  const relayBlock = String(formData.get("relay_block") ?? "");
  const programArea = String(formData.get("program_area") ?? "");
  const objective = String(formData.get("objective") ?? "");
  const achievedObjective = String(formData.get("achieved_objective") ?? "");
  const objectiveReflection = String(formData.get("objective_reflection") ?? "");
  const engagementScaleRaw = String(formData.get("engagement_scale") ?? "");
  const challenges = formData.getAll("challenges").map(String);
  const pivots = String(formData.get("pivots") ?? "");

  const engagementScale = Number(engagementScaleRaw);
  if (!Number.isFinite(engagementScale) || engagementScale < 1 || engagementScale > 5) {
    return { error: "Please rate engagement from 1 to 5." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("close_session_with_relay_feedback", {
    p_session_id: sessionId,
    p_relay_block: relayBlock,
    p_program_area: programArea,
    p_objective: objective,
    p_achieved_objective: achievedObjective,
    p_objective_reflection: objectiveReflection,
    p_engagement_scale: engagementScale,
    p_challenges: challenges,
    p_pivots: pivots || null,
  });
  if (error) return { error: error.message };

  // Session is now closed — redirect home, same as clockIn()
  // (src/app/(app)/clocking/actions.ts): the "Feedback required" banner and
  // "Clock out" nav tile there are both derived from the (now absent) open
  // session, so they disappear on their own with no extra state to thread.
  revalidatePath("/clocking");
  revalidatePath("/feedback");
  revalidatePath("/");
  redirect("/");
}
