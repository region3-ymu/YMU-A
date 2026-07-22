// Server-side CSV export. Cookie-authenticated the same way as
// /api/sync/route.ts (getUser() -> 401 if signed out), then reuses the exact
// same buildReportSections() the Reports page renders from, so what a
// Regional Manager can export is bounded by the same RLS-backed scoping as
// what they can see on screen — passing a teacher id outside their region
// just yields an empty section, same as the page.

import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/auth/dal";
import { isAppRole } from "@/lib/auth/roles";
import { buildReportSections } from "@/lib/reports/build";
import { bucketReportRows } from "@/lib/reports/aggregate";
import { getSchoolYears } from "@/lib/reports/queries";
import { periodSummariesToCsv } from "@/lib/export/csv";
import type { Granularity } from "@/lib/reports/types";

const GRANULARITIES: readonly Granularity[] = ["weekly", "monthly", "quarterly"];

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("id, full_name, phone, role, region, subjects, emergency_contact, archived_at")
    .eq("id", user.id)
    .single();
  if (!profileRow || !isAppRole(profileRow.role)) {
    return Response.json({ error: "No profile found." }, { status: 403 });
  }
  if (profileRow.archived_at) {
    return Response.json({ error: "This account is archived." }, { status: 403 });
  }
  const profile: Profile = { ...profileRow, email: user.email };

  const url = new URL(request.url);
  const granularityParam = url.searchParams.get("granularity");
  const granularity: Granularity = GRANULARITIES.includes(granularityParam as Granularity)
    ? (granularityParam as Granularity)
    : "monthly";
  const teacherParam = url.searchParams.get("teacher") ?? undefined;

  const [report, schoolYears] = await Promise.all([
    buildReportSections(profile, teacherParam),
    getSchoolYears(),
  ]);

  // Bucket each section independently (mirroring report-view.tsx exactly)
  // and only THEN concatenate the resulting summaries — never flatten raw
  // rows across sections first. The master report's sections overlap on
  // purpose (a "combined" section holding every row, plus one section per
  // teacher that's a subset of those same rows); re-bucketing a flattened
  // union of all of them would double-count every teacher's classes.
  const nameById = new Map(report.sections.map((s) => [s.teacherId, s.teacherName]));
  const summaries = report.sections.flatMap((section) =>
    bucketReportRows(section.rows, granularity, schoolYears, section.combineTeachers),
  );
  const csv = periodSummariesToCsv(summaries, nameById);

  const filename = `attendance-report-${granularity}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
