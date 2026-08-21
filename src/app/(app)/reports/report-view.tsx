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
import {
  GRANULARITY_LABELS,
  type Granularity,
  type PeriodSummary,
  type SchoolYear,
} from "@/lib/reports/types";

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

  // A Regional Manager's region view is 1 combined section plus one per
  // teacher who taught — 48 sections on one scroll for Central. Expanded, the
  // few numbers a manager opened the page for were unreachable without
  // thumbing past a hundred cards.
  //
  // So: the combined totals stay open, and each teacher collapses to a single
  // line carrying their whole-window figures, expanding to the same period
  // cards on tap. Nothing is removed — a single-teacher report (`sections`
  // of length 1, the teacher self-report and the RM's one-teacher view) has
  // nothing to collapse and renders exactly as before.
  const combined = summarized.filter((s) => s.combineTeachers);
  const perTeacher = summarized.filter((s) => !s.combineTeachers);
  const collapsible = combined.length > 0 && perTeacher.length > 1;

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

      {(collapsible ? combined : summarized).map((section, index) => (
        <div key={section.teacherId} className="flex flex-col gap-3">
          {!collapsible && archivedStartIndex != null && index === archivedStartIndex && (
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
                      {/* Classes first, then hours. YMU reads these two
                          together and asked for the count (2026-08-21):
                          "cuántas clases impartió cada profesor". It is taught,
                          not scheduled — a missed class is not one they gave. */}
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2.5 py-1 text-xs font-semibold text-on-primary-container">
                        <span className="material-symbols-outlined text-sm" aria-hidden>
                          co_present
                        </span>
                        Classes {row.taughtCount}
                      </span>
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

      {collapsible && (
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold text-on-surface">By teacher</h3>
          {perTeacher.map((section, index) => (
            <div key={section.teacherId} className="flex flex-col gap-2">
              {/* archivedStartIndex counts from the start of `sections`, which
                  begins with the combined block — so it is one ahead of this
                  list's index. */}
              {archivedStartIndex != null && index === archivedStartIndex - combined.length && (
                <h4 className="mb-1 mt-3 text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
                  Archived teachers
                </h4>
              )}
              <TeacherRow name={section.teacherName} summaries={section.summaries} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One collapsed line per teacher: their totals across the whole window, with
// the per-period cards behind a disclosure. <details> rather than React state
// so several can be open at once, each keeps its own state across a
// granularity change, and it works before hydration.
function TeacherRow({ name, summaries }: { name: string; summaries: PeriodSummary[] }) {
  const totals = summaries.reduce(
    (acc, r) => ({
      taught: acc.taught + r.taughtCount,
      hours: acc.hours + r.hoursWorked,
      onTime: acc.onTime + r.onTimeCount,
      late: acc.late + r.lateCount,
      missed: acc.missed + r.missedCount,
    }),
    { taught: 0, hours: 0, onTime: 0, late: 0, missed: 0 },
  );

  return (
    <details className="group overflow-hidden rounded-2xl bg-surface-container shadow-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 p-4">
        <span
          className="material-symbols-outlined text-base text-on-surface-variant transition-transform group-open:rotate-90"
          aria-hidden
        >
          chevron_right
        </span>
        <span className="min-w-0 flex-1 font-medium text-on-surface">{name}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill tone="primary" icon="co_present" label={`Classes ${totals.taught}`} />
          <Pill tone="primary" icon="schedule" label={`Hours ${totals.hours.toFixed(2)}`} />
          <Pill tone="tertiary" icon="check_circle" label={`On time ${totals.onTime}`} />
          {totals.late > 0 && <Pill tone="warning" icon="warning" label={`Late ${totals.late}`} />}
          {totals.missed > 0 && <Pill tone="error" icon="event_busy" label={`Missed ${totals.missed}`} />}
        </span>
      </summary>

      <div className="flex flex-col gap-2 border-t border-outline-variant/40 p-4">
        {summaries.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No classes in range.</p>
        ) : (
          summaries.map((row) => (
            <div
              key={row.periodKey}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-container-low p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">{row.periodLabel}</p>
                <p className="text-xs text-on-surface-variant">{row.periodStart}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Pill tone="primary" icon="co_present" label={`Classes ${row.taughtCount}`} />
                <Pill tone="primary" icon="schedule" label={`Hours ${row.hoursWorked.toFixed(2)}`} />
                <Pill tone="tertiary" icon="check_circle" label={`On time ${row.onTimeCount}`} />
                <Pill tone="warning" icon="warning" label={`Late ${row.lateCount}`} />
                <Pill tone="error" icon="event_busy" label={`Missed ${row.missedCount}`} />
                <Pill tone="neutral" label={`Rate % ${row.attendanceRatePct ?? "—"}`} />
              </div>
            </div>
          ))
        )}
      </div>
    </details>
  );
}

const PILL_TONES = {
  primary: "bg-primary-container text-on-primary-container",
  tertiary: "bg-tertiary-container text-on-tertiary-container",
  warning: "bg-warning-container text-on-warning-container",
  error: "bg-error-container text-on-error-container",
  neutral: "bg-surface-container-high text-on-surface",
} as const;

function Pill({
  tone,
  icon,
  label,
}: {
  tone: keyof typeof PILL_TONES;
  icon?: string;
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${PILL_TONES[tone]}`}
    >
      {icon && (
        <span className="material-symbols-outlined text-sm" aria-hidden>
          {icon}
        </span>
      )}
      {label}
    </span>
  );
}
