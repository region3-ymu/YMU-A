import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { FEEDBACK_READER_ROLES, seesAllTickets } from "@/lib/auth/roles";
import { getFeedbackPage, type SubmittedFeedback } from "@/lib/feedback/queries";
import { ENGAGEMENT_LABELS, ENGAGEMENT_OPTIONS } from "@/lib/feedback/program-match";
import { getReportRoster } from "@/lib/reports/queries";
import { formatDate } from "@/lib/format/datetime";
import FeedbackFilterBar from "./filter-bar";

export const metadata: Metadata = { title: "Feedbacks" };

// What teachers reported about their classes, for the people who manage them.
//
// Until now this data only left the app through the Google Sheet mirror, so
// reading "what did my teachers say this week" meant leaving the app and
// opening a spreadsheet whose ticket columns are frozen at submission time.
//
// There is deliberately no region filter in the query: feedback_submissions_select
// (0030) already scopes a Regional Manager to their own region and lets
// CPO / Operations Manager / Academic Manager read everything. Doing it again
// here would be a second copy of the rule, and the copy outside the database
// is the one that drifts.
export default async function FeedbacksPage({
  searchParams,
}: {
  searchParams: Promise<{
    teacher?: string;
    school?: string;
    from?: string;
    to?: string;
    engagement?: string;
    page?: string;
  }>;
}) {
  const profile = await requireRole(...FEEDBACK_READER_ROLES);
  const params = await searchParams;

  const page = Number.parseInt(params.page ?? "1", 10);
  const { rows, total, pageSize } = await getFeedbackPage({
    teacherId: params.teacher || undefined,
    schoolId: params.school || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    engagement: params.engagement || undefined,
    page: Number.isFinite(page) ? page : 1,
  });

  const roster = await getReportRoster(true);
  const nameById = new Map(roster.map((t) => [t.id, t.full_name]));

  // Schools come from the rows on screen rather than a schools query: the
  // point of the filter is to narrow what is already visible, and a Regional
  // Manager should not be offered a school whose feedback RLS will hide.
  const schools = [...new Map(rows.filter((r) => r.school_id && r.school).map((r) => [r.school_id!, r.school!.name])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const currentPage = Math.max(1, Number.isFinite(page) ? page : 1);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastShown = Math.min(currentPage * pageSize, total);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
          aria-hidden
        >
          <span className="material-symbols-outlined">rate_review</span>
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">Feedbacks</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            {seesAllTickets(profile.role)
              ? "Daily class logs from every region."
              : "Daily class logs from your region."}
          </p>
        </div>
      </header>

      <FeedbackFilterBar
        teachers={roster.map((t) => ({ id: t.id, name: t.full_name }))}
        schools={schools}
        engagementOptions={ENGAGEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        current={{
          teacher: params.teacher ?? "",
          school: params.school ?? "",
          from: params.from ?? "",
          to: params.to ?? "",
          engagement: params.engagement ?? "",
        }}
      />

      {total === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            inbox
          </span>
          <p className="text-sm text-on-surface-variant">No feedback matches those filters.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-on-surface-variant">
            Showing {firstShown}–{lastShown} of {total}
          </p>
          <ul className="grid gap-3">
            {rows.map((row) => (
              <FeedbackCard
                key={row.id}
                row={row}
                teacherName={nameById.get(row.teacher_id) ?? "Unknown teacher"}
              />
            ))}
          </ul>
          {lastPage > 1 && (
            <nav className="flex items-center justify-between gap-3 text-sm">
              <PageLink params={params} page={currentPage - 1} disabled={currentPage === 1}>
                ← Newer
              </PageLink>
              <span className="text-on-surface-variant">
                Page {currentPage} of {lastPage}
              </span>
              <PageLink params={params} page={currentPage + 1} disabled={currentPage >= lastPage}>
                Older →
              </PageLink>
            </nav>
          )}
        </>
      )}
    </main>
  );
}

function FeedbackCard({ row, teacherName }: { row: SubmittedFeedback; teacherName: string }) {
  const cancelled = row.engagement_level === "Canceled";
  return (
    <li className="relative overflow-hidden rounded-2xl bg-surface-container shadow-sm">
      <div
        className={`absolute inset-y-0 left-0 w-1.5 ${
          cancelled ? "bg-warning" : row.engagement_level === "Low" ? "bg-error" : "bg-primary"
        }`}
        aria-hidden
      />
      <Link href={`/feedbacks/${row.id}`} className="block p-4 pl-5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-semibold text-on-surface">{teacherName}</p>
          <p className="shrink-0 text-xs text-on-surface-variant">
            {row.event?.start_at ? formatDate(row.event.start_at) : formatDate(row.submitted_at)}
          </p>
        </div>
        <p className="mt-0.5 text-sm text-on-surface-variant">
          {row.event?.summary ?? row.program?.name ?? "Class"}
          {row.school?.name ? ` · ${row.school.name}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip
            label={ENGAGEMENT_LABELS[row.engagement_level] ?? row.engagement_level}
            tone={cancelled ? "warning" : row.engagement_level === "Low" ? "error" : "neutral"}
          />
          {row.quarter_goals_on_track === false && <Chip label="Behind on goals" tone="warning" />}
          {row.has_issue && <Chip label="Issue reported" tone="error" />}
        </div>
      </Link>
    </li>
  );
}

function Chip({ label, tone }: { label: string; tone: "neutral" | "warning" | "error" }) {
  const toneClass =
    tone === "error"
      ? "bg-error-container text-on-error-container"
      : tone === "warning"
        ? "bg-warning-container text-on-warning-container"
        : "bg-surface-container-high text-on-surface-variant";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${toneClass}`}>
      {label}
    </span>
  );
}

function PageLink({
  params,
  page,
  disabled,
  children,
}: {
  params: Record<string, string | undefined>;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-on-surface-variant opacity-40">{children}</span>;
  }
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "page") next.set(key, value);
  }
  next.set("page", String(page));
  return (
    <Link href={`/feedbacks?${next.toString()}`} className="font-semibold text-primary hover:underline">
      {children}
    </Link>
  );
}
