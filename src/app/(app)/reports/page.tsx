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
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>
            analytics
          </span>
          Reports
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Hours worked, attendance rate, and on-time/late/missed counts — weekly, monthly, or per
          9-week quarter.
        </p>
      </header>

      <SearchBox />

      {report.canPickTeacher && profile.role === "regional_manager" && (
        <form className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="teacher" className="font-medium text-on-surface-variant">
            Teacher
          </label>
          <select
            id="teacher"
            name="teacher"
            defaultValue={teacherParam ?? ""}
            className="rounded-lg bg-surface-container-low px-3 py-2 text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All teachers in my region</option>
            {roster.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-full bg-primary px-5 py-2 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98]"
          >
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
