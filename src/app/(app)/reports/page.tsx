import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { getReportRoster, getSchoolYears } from "@/lib/reports/queries";
import { buildReportSections } from "@/lib/reports/build";
import { rangeOptions, resolveRange } from "@/lib/reports/range";
import SearchBox from "@/components/search-box";
import ReportView from "./report-view";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ teacher?: string; range?: string }>;
}) {
  const profile = await requireProfile();
  const { teacher, range } = await searchParams;
  const teacherParam = teacher && teacher.length > 0 ? teacher : undefined;

  // The range must resolve before the report is built — it bounds the query
  // rather than filtering afterwards — so school years are fetched first
  // instead of in parallel with everything else. resolveRange tolerates an
  // unknown or missing key, so a stale bookmark still renders.
  const schoolYears = await getSchoolYears();
  const resolvedRange = resolveRange(range, schoolYears);

  const [report, roster] = await Promise.all([
    buildReportSections(profile, teacherParam, resolvedRange),
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
          Hours worked, attendance rate, and on-time/late/missed counts. Group by day, week,
          month, 9-week quarter, or school year.
        </p>
      </header>

      <SearchBox />

      {report.canPickTeacher && profile.role === "regional_manager" && (
        <form className="flex flex-wrap items-center gap-2 text-sm">
          {/* Carried through so changing teacher doesn't silently reset the
              range back to its default. */}
          <input type="hidden" name="range" value={resolvedRange.key} />
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
        range={resolvedRange}
        rangeOptions={rangeOptions(schoolYears)}
      />
    </main>
  );
}
