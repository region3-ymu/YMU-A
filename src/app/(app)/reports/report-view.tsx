"use client";

// Renders whatever section list build.ts produced (one section for a
// teacher's self-report, one for a Regional Manager's single-teacher/
// region view, or several for the OM/CPO master report) with a
// weekly/monthly/quarterly picker. Bucketing is pure client-side math
// (lib/reports/aggregate.ts) over rows already fetched server-side, so
// switching granularity needs no round trip. CSV goes through the real
// server export route; PDF renders client-side from the same summarized
// data already on screen.

import { useMemo, useState } from "react";
import { bucketReportRows } from "@/lib/reports/aggregate";
import type { ReportSectionData } from "@/lib/reports/build";
import type { Granularity, SchoolYear } from "@/lib/reports/types";
import { downloadReportPdf } from "@/lib/export/pdf";

export default function ReportView({
  title,
  sections,
  archivedStartIndex,
  schoolYears,
  exportFilenameBase,
  teacherParam,
}: {
  title: string;
  sections: ReportSectionData[];
  archivedStartIndex?: number;
  schoolYears: SchoolYear[];
  exportFilenameBase: string;
  teacherParam?: string;
}) {
  const [granularity, setGranularity] = useState<Granularity>("monthly");
  const [pdfPending, setPdfPending] = useState(false);

  const summarized = useMemo(
    () =>
      sections.map((section) => ({
        ...section,
        summaries: bucketReportRows(section.rows, granularity, schoolYears, section.combineTeachers),
      })),
    [sections, granularity, schoolYears],
  );

  async function handlePdf() {
    setPdfPending(true);
    try {
      await downloadReportPdf({
        title,
        subtitle: `Generated ${new Date().toLocaleDateString()} · grouped ${granularity}`,
        sections: summarized.map((s) => ({ teacherName: s.teacherName, rows: s.summaries })),
        filename: `${exportFilenameBase}-${granularity}.pdf`,
      });
    } finally {
      setPdfPending(false);
    }
  }

  const csvHref = `/api/reports/export?granularity=${granularity}${
    teacherParam ? `&teacher=${encodeURIComponent(teacherParam)}` : ""
  }`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="granularity" className="text-sm font-medium">
          Group by
        </label>
        <select
          id="granularity"
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as Granularity)}
          className="rounded-lg border border-foreground/20 bg-transparent px-2 py-1 text-sm"
        >
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="quarterly">9-week quarter</option>
        </select>
        <a
          href={csvHref}
          className="rounded-lg border border-foreground/20 px-3 py-1 text-sm"
        >
          Download CSV
        </a>
        <button
          type="button"
          onClick={handlePdf}
          disabled={pdfPending}
          className="rounded-lg border border-foreground/20 px-3 py-1 text-sm disabled:opacity-50"
        >
          {pdfPending ? "Preparing…" : "Download PDF"}
        </button>
      </div>

      {summarized.map((section, index) => (
        <div key={section.teacherId}>
          {archivedStartIndex != null && index === archivedStartIndex && (
            <h2 className="mb-3 mt-2 text-lg font-semibold opacity-80">Archived teachers</h2>
          )}
          <h3 className="mb-2 font-semibold">{section.teacherName}</h3>
          {section.summaries.length === 0 ? (
            <p className="mb-4 text-sm opacity-60">No classes in range.</p>
          ) : (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-foreground/20 text-left">
                    <th className="py-1 pr-3 font-medium">Period</th>
                    <th className="py-1 pr-3 font-medium">Hours</th>
                    <th className="py-1 pr-3 font-medium">On time</th>
                    <th className="py-1 pr-3 font-medium">Late</th>
                    <th className="py-1 pr-3 font-medium">Missed</th>
                    <th className="py-1 pr-3 font-medium">Rate %</th>
                  </tr>
                </thead>
                <tbody>
                  {section.summaries.map((row) => (
                    <tr key={row.periodKey} className="border-b border-foreground/10">
                      <td className="py-1 pr-3">
                        {row.periodLabel} ({row.periodStart})
                      </td>
                      <td className="py-1 pr-3">{row.hoursWorked.toFixed(2)}</td>
                      <td className="py-1 pr-3">{row.onTimeCount}</td>
                      <td className="py-1 pr-3">{row.lateCount}</td>
                      <td className="py-1 pr-3">{row.missedCount}</td>
                      <td className="py-1 pr-3">{row.attendanceRatePct ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
