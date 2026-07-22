import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { getReportRoster, getSchoolYears } from "@/lib/reports/queries";
import { buildReportSections } from "@/lib/reports/build";
import SearchBox from "@/components/search-box";
import ReportView from "./report-view";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ teacher?: string }>;
}) {
  const profile = await requireProfile();
  const { teacher } = await searchParams;
  const teacherParam = teacher && teacher.length > 0 ? teacher : undefined;

  const [schoolYears, report, roster] = await Promise.all([
    getSchoolYears(),
    buildReportSections(profile, teacherParam),
    profile.role === "regional_manager" ? getReportRoster(false) : Promise.resolve([]),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm opacity-70">
          Hours worked, attendance rate, and on-time/late/missed counts — weekly, monthly, or per
          9-week quarter.
        </p>
      </header>

      <SearchBox />

      {report.canPickTeacher && profile.role === "regional_manager" && (
        <form className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="teacher" className="font-medium">
            Teacher
          </label>
          <select
            id="teacher"
            name="teacher"
            defaultValue={teacherParam ?? ""}
            className="rounded-lg border border-foreground/20 bg-transparent px-2 py-1"
          >
            <option value="">All teachers in my region</option>
            {roster.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded-lg border border-foreground/20 px-3 py-1">
            View
          </button>
        </form>
      )}

      <ReportView
        title={report.title}
        sections={report.sections}
        archivedStartIndex={report.archivedStartIndex}
        schoolYears={schoolYears}
        exportFilenameBase="attendance-report"
        teacherParam={teacherParam}
      />
    </main>
  );
}
