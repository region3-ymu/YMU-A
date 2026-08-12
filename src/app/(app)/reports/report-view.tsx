"use client";

// Renders whatever section list build.ts produced (one section for a
// teacher's self-report, one for a Regional Manager's single-teacher/
// region view, or several for the OM/CPO master report).
//
// Two controls, answering two different questions:
//
//   Group by  -> client state. Bucketing is pure math (lib/reports/aggregate)
//                over rows already in the browser, so switching is instant.
//   Range     -> a URL param. It bounds the server query, so changing it has
//                to round-trip; there is no way to widen a window client-side
//                from rows that were never fetched.
//
// CSV goes through the real server export route; PDF renders client-side from
// the same summarized data already on screen.

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { bucketReportRows } from "@/lib/reports/aggregate";
import type { ReportSectionData } from "@/lib/reports/build";
import type { ReportRange } from "@/lib/reports/range";
import { GRANULARITY_LABELS, type Granularity, type SchoolYear } from "@/lib/reports/types";

const GRANULARITY_ORDER: Granularity[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

export default function ReportView({
  title,
  sections,
  archivedStartIndex,
  schoolYears,
  exportFilenameBase,
  teacherParam,
  range,
  rangeOptions,
}: {
  title: string;
  sections: ReportSectionData[];
  archivedStartIndex?: number;
  schoolYears: SchoolYear[];
  exportFilenameBase: string;
  teacherParam?: string;
  range: ReportRange;
  rangeOptions: { key: string; label: string }[];
}) {
  // Weekly is the default the user asked for. It was "monthly", which made a
  // single class look like noise in a 30-row bucket.
  const [granularity, setGranularity] = useState<Granularity>("weekly");
  const [pdfPending, setPdfPending] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const [rangePending, startRangeTransition] = useTransition();

  function changeRange(key: string) {
    const params = new URLSearchParams();
    params.set("range", key);
    if (teacherParam) params.set("teacher", teacherParam);
    startRangeTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

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
      // @react-pdf/renderer (~1.4MB with its yoga layout dependency) is
      // loaded on demand here rather than imported at module scope — every
      // /reports page load was otherwise shipping it whether or not the
      // teacher ever clicks "Download PDF".
      const { downloadReportPdf } = await import("@/lib/export/pdf");
      await downloadReportPdf({
        title,
        subtitle: `${range.label} · grouped ${granularity}`,
        sections: summarized.map((s) => ({ teacherName: s.teacherName, rows: s.summaries })),
        filename: `${exportFilenameBase}-${granularity}.pdf`,
      });
    } finally {
      setPdfPending(false);
    }
  }

  const csvHref = `/api/reports/export?granularity=${granularity}&range=${encodeURIComponent(range.key)}${
    teacherParam ? `&teacher=${encodeURIComponent(teacherParam)}` : ""
  }`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="granularity" className="text-sm font-medium text-on-surface-variant">
          Group by
        </label>
        <select
          id="granularity"
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as Granularity)}
          className="rounded-full bg-surface-container-low px-4 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          {GRANULARITY_ORDER.map((g) => (
            <option key={g} value={g}>{GRANULARITY_LABELS[g]}</option>
          ))}
        </select>

        <label htmlFor="range" className="text-sm font-medium text-on-surface-variant">
          Showing
        </label>
        <select
          id="range"
          value={range.key}
          disabled={rangePending}
          onChange={(e) => changeRange(e.target.value)}
          className="rounded-full bg-surface-container-low px-4 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
        >
          {rangeOptions.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a
            href={csvHref}
            className="inline-flex items-center gap-2 rounded-full border-2 border-outline px-4 py-2 text-sm font-bold text-on-surface"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>
              download
            </span>
            Download CSV
          </a>
          <button
            type="button"
            onClick={handlePdf}
            disabled={pdfPending}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>
              picture_as_pdf
            </span>
            {pdfPending ? "Preparing…" : "Download PDF"}
          </button>
        </div>
      </div>

      {summarized.map((section, index) => (
        <div key={section.teacherId} className="flex flex-col gap-3">
          {archivedStartIndex != null && index === archivedStartIndex && (
            <h2 className="mb-1 mt-2 text-lg font-semibold text-on-surface-variant">Archived teachers</h2>
          )}
          <h3 className="font-semibold text-on-surface">{section.teacherName}</h3>
          {section.summaries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
              <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
                event_busy
              </span>
              <p className="text-sm text-on-surface-variant">No classes in range.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {section.summaries.map((row) => (
                <div
                  key={row.periodKey}
                  className="relative overflow-hidden rounded-2xl bg-surface-container p-4 shadow-sm"
                >
                  <div
                    className={`absolute inset-y-0 left-0 w-1.5 ${
                      row.missedCount > 0
                        ? "bg-error"
                        : row.lateCount > 0
                          ? "bg-warning"
                          : "bg-tertiary"
                    }`}
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3 pl-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-on-surface">{row.periodLabel}</p>
                      <p className="text-sm text-on-surface-variant">{row.periodStart}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2.5 py-1 text-xs font-semibold text-on-primary-container">
                        <span className="material-symbols-outlined text-sm" aria-hidden>
                          schedule
                        </span>
                        Hours {row.hoursWorked.toFixed(2)}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-tertiary-container px-2.5 py-1 text-xs font-semibold text-on-tertiary-container">
                        <span className="material-symbols-outlined text-sm" aria-hidden>
                          check_circle
                        </span>
                        On time {row.onTimeCount}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning-container px-2.5 py-1 text-xs font-semibold text-on-warning-container">
                        <span className="material-symbols-outlined text-sm" aria-hidden>
                          warning
                        </span>
                        Late {row.lateCount}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-error-container px-2.5 py-1 text-xs font-semibold text-on-error-container">
                        <span className="material-symbols-outlined text-sm" aria-hidden>
                          event_busy
                        </span>
                        Missed {row.missedCount}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-semibold text-on-surface">
                        Rate % {row.attendanceRatePct ?? "—"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
