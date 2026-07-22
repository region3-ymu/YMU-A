// Builds the section list every report surface renders: the teacher
// self-report, the Regional Manager per-teacher/region report, and the
// Operations Manager/CPO master report (combined + one section per active
// teacher + an archived-teachers section). Shared by the Reports page and
// the CSV export route so both always show/export the exact same data —
// see app/(app)/reports/page.tsx and app/api/reports/export/route.ts.
//
// Only ONE query fetches rows for OM/CPO and for an RM's "all teachers"
// view (getReportRows({}) — attendance_period_rows' own WHERE clause scopes
// it to what the caller may see); per-teacher sections then just filter
// that same array in memory by teacher_id, rather than issuing N queries.

import type { Profile } from "@/lib/auth/dal";
import { getReportRoster, getReportRows } from "./queries";
import type { ReportRow } from "./types";

export type ReportSectionData = {
  teacherId: string;
  teacherName: string;
  rows: ReportRow[];
  // True only for a synthetic "all teachers" total — bucketReportRows()
  // merges every teacher into one set of period totals instead of its
  // default one-bucket-per-teacher grouping. Per-teacher sections leave
  // this unset so each teacher's own numbers stay separate.
  combineTeachers?: boolean;
};

export type ReportBundle = {
  title: string;
  sections: ReportSectionData[];
  archivedStartIndex?: number;
  canPickTeacher: boolean;
};

export async function buildReportSections(
  profile: Profile,
  teacherId?: string,
): Promise<ReportBundle> {
  if (profile.role === "teacher") {
    const rows = await getReportRows({ teacherId: profile.id });
    return {
      title: `${profile.full_name} — attendance report`,
      sections: [{ teacherId: profile.id, teacherName: profile.full_name, rows }],
      canPickTeacher: false,
    };
  }

  if (profile.role === "regional_manager") {
    if (teacherId) {
      const roster = await getReportRoster(false);
      const teacher = roster.find((t) => t.id === teacherId);
      const rows = await getReportRows({ teacherId });
      return {
        title: `${teacher?.full_name ?? "Teacher"} — attendance report`,
        sections: [{ teacherId, teacherName: teacher?.full_name ?? "Teacher", rows }],
        canPickTeacher: true,
      };
    }
    const rows = await getReportRows({});
    return {
      title: "Region attendance report — all teachers",
      sections: [
        { teacherId: "all", teacherName: "All teachers in my region", rows, combineTeachers: true },
      ],
      canPickTeacher: true,
    };
  }

  // operations_manager / cpo — the master report.
  const [roster, allRows] = await Promise.all([getReportRoster(true), getReportRows({})]);
  const active = roster.filter((t) => !t.archived_at);
  const archived = roster.filter((t) => t.archived_at);

  const sections: ReportSectionData[] = [
    { teacherId: "all", teacherName: "All teachers (combined)", rows: allRows, combineTeachers: true },
    ...active.map((t) => ({
      teacherId: t.id,
      teacherName: t.full_name,
      rows: allRows.filter((r) => r.teacher_id === t.id),
    })),
    ...archived.map((t) => ({
      teacherId: t.id,
      teacherName: `${t.full_name} (archived)`,
      rows: allRows.filter((r) => r.teacher_id === t.id),
    })),
  ];

  return {
    title: "Master attendance report — Operations",
    sections,
    archivedStartIndex: 1 + active.length,
    canPickTeacher: false,
  };
}
