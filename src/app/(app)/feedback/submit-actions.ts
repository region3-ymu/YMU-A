"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { getTopicsForProgram } from "@/lib/feedback/queries";
import { issueCategoryFor, MIN_ISSUE_DESCRIPTION } from "@/lib/feedback/program-match";
import { buildObjectivePayload, describeObjectiveGap } from "@/lib/feedback/objectives";

export type ClassFeedbackState = { error?: string } | undefined;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// PRD Module A. Every rule here is also enforced in submit_class_feedback()
// — this layer exists to return a readable message instead of a raised
// Postgres exception, not to be the gate.
export async function submitClassFeedback(
  _previous: ClassFeedbackState,
  formData: FormData,
): Promise<ClassFeedbackState> {
  await requireRole("teacher");

  const sessionId = String(formData.get("session_id") ?? "");
  if (!isUuid(sessionId)) return { error: "No class selected." };

  const engagement = String(formData.get("engagement_level") ?? "");
  if (!["High", "Solid", "Low"].includes(engagement)) {
    return { error: "Please choose how students engaged today." };
  }

  const onTrackRaw = String(formData.get("quarter_goals_on_track") ?? "");
  if (onTrackRaw !== "yes" && onTrackRaw !== "no") {
    return { error: "Please answer whether you're on track with quarter goals." };
  }
  const onTrack = onTrackRaw === "yes";

  const programIdRaw = String(formData.get("program_id") ?? "");
  const programId = isUuid(programIdRaw) ? programIdRaw : null;
  const programName = String(formData.get("program_name") ?? "").trim() || null;

  // Section 2. buildObjectivePayload is what guarantees the two halves are
  // mutually exclusive (spec §5) — running it here rather than trusting the
  // form's hidden inputs means a hand-crafted POST carrying both is normalised
  // to one before it can reach the RPC.
  const objectives = buildObjectivePayload({
    isCustom: String(formData.get("is_custom_program") ?? "") === "yes",
    objectives: formData.getAll("objectives_worked").map(String),
    customProgramName: String(formData.get("custom_program_name") ?? ""),
    customNotes: String(formData.get("custom_notes") ?? ""),
  });

  // Only objectives that really belong to the detected program. The checkboxes
  // are rendered from that program's list, but a hand-crafted POST could send
  // any string, and a foreign or invented objective would silently corrupt the
  // curriculum aggregates this data exists to feed. Enforced again in
  // submit_class_feedback(); this layer exists to say so readably.
  const offered = objectives.is_custom_program ? [] : await getTopicsForProgram(programId);
  if (!objectives.is_custom_program) {
    const allowed = new Set(offered.map((t) => t.topic_name));
    objectives.objectives_worked = objectives.objectives_worked.filter((o) => allowed.has(o));
  }

  const gap = describeObjectiveGap(
    {
      isCustom: objectives.is_custom_program,
      objectives: objectives.objectives_worked,
      customProgramName: objectives.custom_program_name ?? "",
      customNotes: objectives.custom_notes ?? "",
    },
    { offersObjectives: offered.length > 0 },
  );
  if (gap) return { error: gap };

  const hasIssue = String(formData.get("has_issue") ?? "") === "yes";
  const subcategory = String(formData.get("issue_subcategory") ?? "").trim() || null;
  const description = String(formData.get("issue_description") ?? "").trim();
  const priority = String(formData.get("priority_level") ?? "Normal");

  if (hasIssue) {
    if (!subcategory) return { error: "Please choose what kind of support you need." };
    if (description.length < MIN_ISSUE_DESCRIPTION) {
      return {
        error: `Please describe the issue in at least ${MIN_ISSUE_DESCRIPTION} characters.`,
      };
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_class_feedback", {
    p_session_id: sessionId,
    p_engagement_level: engagement,
    p_quarter_goals_on_track: onTrack,
    p_program_id: programId,
    p_program_name_raw: programName,
    p_objectives_worked: objectives.objectives_worked,
    p_is_custom_program: objectives.is_custom_program,
    p_custom_program_name: objectives.custom_program_name,
    p_custom_notes: objectives.custom_notes,
    p_has_issue: hasIssue,
    // Derived server-side from the subcategory rather than trusted from the
    // form: it decides which bucket the ticket lands in for PD reporting.
    p_issue_category: hasIssue ? issueCategoryFor(subcategory) : null,
    p_issue_subcategory: subcategory,
    p_issue_description: hasIssue ? description : null,
    p_priority_level: ["Urgent", "High", "Normal"].includes(priority) ? priority : "Normal",
  });
  if (error) return { error: error.message };

  revalidatePath("/feedback");
  revalidatePath("/clocking");
  revalidatePath("/tickets");
  revalidatePath("/");
  redirect("/feedback?submitted=1");
}
