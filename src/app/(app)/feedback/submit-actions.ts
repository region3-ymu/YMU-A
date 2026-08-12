"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { getTopicsForProgram } from "@/lib/feedback/queries";
import { issueCategoryFor, MIN_ISSUE_DESCRIPTION } from "@/lib/feedback/program-match";

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
  const pillar = String(formData.get("primary_focus_pillar") ?? "").trim() || null;
  const openNote = String(formData.get("open_topic_note") ?? "").trim() || null;

  // Only keep chips that really belong to the chosen program. The checkboxes
  // are rendered from that program's list, but a hand-crafted POST could name
  // any uuid, and a topic from another program would silently corrupt the
  // curriculum aggregates this data exists to feed.
  const submittedTopicIds = formData.getAll("topic_ids").map(String).filter(isUuid);
  let topicIds: string[] = [];
  if (submittedTopicIds.length > 0 && programId) {
    const allowed = new Set((await getTopicsForProgram(programId)).map((t) => t.id));
    topicIds = submittedTopicIds.filter((id) => allowed.has(id));
  }

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
    p_primary_focus_pillar: pillar,
    p_specific_topic_ids: topicIds,
    p_open_topic_note: openNote,
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
