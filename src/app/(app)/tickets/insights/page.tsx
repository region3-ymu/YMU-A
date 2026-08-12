import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { isManagerRole, seesAllTickets } from "@/lib/auth/roles";
import { redirect } from "next/navigation";
import {
  getAgentMetrics,
  getRootCauseReport,
  getWorkloadTrend,
  type RootCauseRow,
  type WorkloadWeek,
} from "@/lib/tickets/queries";
import { formatDuration } from "@/lib/tickets/status";
import { formatDate } from "@/lib/format/datetime";

export const metadata: Metadata = { title: "Ticket insights" };

const ROOT_CAUSE_LABELS: Record<string, string> = {
  Curriculum_Pedagogy: "Curriculum & pedagogy",
  Technology_Software: "Technology & software",
  Facilities_Logistics: "Facilities & logistics",
  Classroom_Mgmt_Safety: "Classroom management & safety",
  Payroll_Administrative: "Payroll & administrative",
};

// PRD 4.4 and 4.5 on one page.
//
// 4.4 is emphatic that these numbers belong to the manager first: "total
// transparency, not a black box", reviewed together in 1-on-1s rather than
// sprung on someone. So the page opens with the reader's OWN figures and never
// ranks colleagues against each other.
//
// Every figure comes from SQL (agent_ticket_metrics / root_cause_report over
// the ticket_sla view), so what a Regional Manager sees here and what the CPO
// sees for the same ticket are the same number by construction.
export default async function TicketInsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const profile = await requireProfile();
  // Teachers have no queue to measure. Not in ROUTE_ROLES because /tickets
  // itself is open to everyone; this is the one sub-route that isn't.
  if (!isManagerRole(profile.role) && !seesAllTickets(profile.role)) redirect("/tickets");

  const { days } = await searchParams;
  const period = days === "7" || days === "90" ? Number(days) : 30;

  const [metrics, trend, rootCauses] = await Promise.all([
    getAgentMetrics(period),
    getWorkloadTrend(8),
    getRootCauseReport(),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/tickets" className="flex items-center gap-1 text-sm text-on-surface-variant hover:underline">
          <span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>
          Tickets
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-on-surface">Your ticket insights</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Your own queue and response times{seesAllTickets(profile.role) ? " across every region" : ""}.
        </p>
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
          Right now
        </h2>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Open" value={metrics?.open_total ?? 0} />
          <Stat label="Urgent" value={metrics?.open_urgent ?? 0} tone={metrics?.open_urgent ? "error" : undefined} />
          <Stat label="Due soon" value={metrics?.open_warning ?? 0} tone={metrics?.open_warning ? "warning" : undefined} />
          <Stat label="Overdue" value={metrics?.open_breached ?? 0} tone={metrics?.open_breached ? "error" : undefined} />
        </div>
        {(metrics?.unanswered ?? 0) > 0 && (
          <Link
            href="/tickets?view=overdue"
            className="mt-3 block rounded-2xl bg-error-container p-4 text-on-error-container"
          >
            <p className="font-semibold">
              {metrics!.unanswered} ticket{metrics!.unanswered === 1 ? "" : "s"} with no reply after 24 hours
            </p>
            <p className="mt-0.5 text-sm opacity-90">Open the overdue tab →</p>
          </Link>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            Last {period} days
          </h2>
          <div className="flex gap-1 text-xs">
            {[7, 30, 90].map((d) => (
              <Link
                key={d}
                href={`/tickets/insights?days=${d}`}
                className={`rounded-full px-3 py-1 font-medium ${
                  period === d ? "bg-primary text-on-primary" : "bg-surface-container-low text-on-surface-variant"
                }`}
              >
                {d}d
              </Link>
            ))}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Stat label="Resolved" value={metrics?.resolved_in_period ?? 0} />
          <Stat
            label="SLA met"
            value={metrics?.sla_compliance_pct == null ? "—" : `${metrics.sla_compliance_pct}%`}
            hint={metrics?.sla_compliance_pct == null ? "Nothing resolved yet" : undefined}
          />
          <Stat label="First reply" value={formatDuration(metrics?.avg_frt_minutes)} hint="average" />
          <Stat
            label="Time to resolve"
            value={formatDuration(metrics?.avg_effective_ttr_minutes)}
            // PRD 4.3's Effective Resolution Time: total elapsed minus the
            // stretches where the ticket was waiting on the teacher or a
            // vendor, so nobody is judged on someone else's delay.
            hint="excludes waiting time"
          />
        </div>
        {(metrics?.reopen_rate_pct ?? 0) > 5 && (
          <p className="mt-2 rounded-lg bg-warning-container p-3 text-sm text-on-warning-container">
            {metrics!.reopen_rate_pct}% of resolved tickets were reopened. The target is under 5% — worth a
            look at whether they were closed too early.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
          Weekly volume
        </h2>
        <WorkloadChart weeks={trend} />
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
          What keeps going wrong
        </h2>
        <p className="mt-0.5 text-sm text-on-surface-variant">
          Recorded causes on resolved tickets. This is the list that should shape Summer PD and mid-year
          workshops.
        </p>
        {rootCauses.length === 0 ? (
          <p className="mt-2 rounded-2xl bg-surface-container p-4 text-sm text-on-surface-variant">
            Nothing resolved yet, so there are no causes to count.
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {rootCauses.map((row) => (
              <RootCauseBar key={`${row.root_cause_category}-${row.category_type}`} row={row} max={rootCauses[0].tickets} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "error" | "warning";
}) {
  const toneClass =
    tone === "error" ? "text-error" : tone === "warning" ? "text-on-warning-container" : "text-on-surface";
  return (
    <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <p className="text-xs font-medium text-on-surface-variant">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
      {hint && <p className="text-xs text-on-surface-variant">{hint}</p>}
    </div>
  );
}

// A plain bar chart in CSS. No chart library for eight numbers — it would be
// more bytes than the rest of the page.
function WorkloadChart({ weeks }: { weeks: WorkloadWeek[] }) {
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.opened, w.resolved)));
  return (
    <div className="mt-2 rounded-2xl bg-surface-container p-4 shadow-sm">
      <div className="flex items-end justify-between gap-2" style={{ height: 120 }}>
        {weeks.map((w) => (
          <div key={w.week_start} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex w-full items-end justify-center gap-0.5" style={{ height: 96 }}>
              <div
                className="w-2 rounded-t bg-primary"
                style={{ height: `${(w.opened / max) * 100}%` }}
                title={`${w.opened} opened`}
              />
              <div
                className="w-2 rounded-t bg-tertiary"
                style={{ height: `${(w.resolved / max) * 100}%` }}
                title={`${w.resolved} resolved`}
              />
            </div>
            <span className="text-[10px] text-on-surface-variant">
              {formatDate(`${w.week_start}T12:00:00Z`).replace(/, \d{4}$/, "")}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 flex gap-4 text-xs text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-primary" aria-hidden /> Opened
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-tertiary" aria-hidden /> Resolved
        </span>
      </p>
    </div>
  );
}

function RootCauseBar({ row, max }: { row: RootCauseRow; max: number }) {
  return (
    <li className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-on-surface">
          {ROOT_CAUSE_LABELS[row.root_cause_category] ?? row.root_cause_category}
        </p>
        <p className="shrink-0 text-sm font-bold text-on-surface">{row.tickets}</p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-container-highest">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(row.tickets / max) * 100}%` }} />
      </div>
      <p className="mt-1 text-xs text-on-surface-variant">
        {row.category_type} · {row.schools_affected} school{row.schools_affected === 1 ? "" : "s"} ·{" "}
        {row.teachers_affected} teacher{row.teachers_affected === 1 ? "" : "s"} · avg{" "}
        {formatDuration(row.avg_effective_ttr_minutes)} to resolve
      </p>
    </li>
  );
}
