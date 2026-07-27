// CSV export for this week's native PD relay feedback (migration 0022) —
// the "save it in a spreadsheet" ask, without building a live Google Sheets
// sync for a one-week form. Cookie-authenticated + OM/CPO-checked manually
// (not requireRole(), which redirect()s — wrong for a route handler a
// browser download link hits directly), same pattern as
// /api/reports/export/route.ts.

import { createClient } from "@/lib/supabase/server";
import { getReportRoster } from "@/lib/reports/queries";
import { relayFeedbackRowsToCsv, type RelayFeedbackRow } from "@/lib/export/csv";

type SessionRow = {
  teacher_id: string;
  clock_in_at: string;
  relay_block: string | null;
  relay_program_area: string | null;
  relay_objective: string | null;
  relay_achieved_objective: string | null;
  relay_objective_reflection: string | null;
  relay_engagement_scale: number | null;
  relay_challenges: string[] | null;
  relay_pivots: string | null;
  relay_feedback_submitted_at: string | null;
  school: { name: string } | null;
  event: { summary: string | null } | null;
};

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role, archived_at")
    .eq("id", user.id)
    .single();
  if (!profileRow || (profileRow.role !== "operations_manager" && profileRow.role !== "cpo")) {
    return Response.json({ error: "Only Operations Managers and the CPO can export this." }, { status: 403 });
  }
  if (profileRow.archived_at) {
    return Response.json({ error: "This account is archived." }, { status: 403 });
  }

  const [{ data: sessions }, roster] = await Promise.all([
    supabase
      .from("attendance_sessions")
      .select(
        "teacher_id, clock_in_at, relay_block, relay_program_area, relay_objective, relay_achieved_objective, " +
          "relay_objective_reflection, relay_engagement_scale, relay_challenges, relay_pivots, relay_feedback_submitted_at, " +
          "school:schools(name), event:calendar_events(summary)",
      )
      .not("relay_block", "is", null)
      .order("relay_feedback_submitted_at", { ascending: false }),
    getReportRoster(true),
  ]);

  const nameById = new Map(roster.map((t) => [t.id, t.full_name]));
  const rows: RelayFeedbackRow[] = ((sessions as unknown as SessionRow[]) ?? []).map((s) => ({
    teacherName: nameById.get(s.teacher_id) ?? s.teacher_id,
    schoolName: s.school?.name ?? "",
    className: s.event?.summary ?? "",
    clockInAt: s.clock_in_at,
    relayBlock: s.relay_block,
    programArea: s.relay_program_area,
    objective: s.relay_objective,
    achievedObjective: s.relay_achieved_objective,
    objectiveReflection: s.relay_objective_reflection,
    engagementScale: s.relay_engagement_scale,
    challenges: s.relay_challenges,
    pivots: s.relay_pivots,
    submittedAt: s.relay_feedback_submitted_at,
  }));

  const csv = relayFeedbackRowsToCsv(rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pd-relay-feedback.csv"`,
    },
  });
}
