import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { seesAllTickets } from "@/lib/auth/roles";
import { getTicketSlaMap, getTickets, type TicketRow, type TicketSla } from "@/lib/tickets/queries";
import { formatDuration, SLA_LABELS, STATUS_LABELS } from "@/lib/tickets/status";
import { formatDateTime } from "@/lib/format/datetime";

export const metadata: Metadata = { title: "Tickets" };

// Replaces the Zoho Desk inbox. Scoping is entirely RLS (migration 0030):
// a teacher sees the tickets they raised, a Regional Manager sees their
// region's, and the Academic Manager / OM / CPO see everything.
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const profile = await requireProfile();
  const { view } = await searchParams;
  const tab = view === "all" || view === "overdue" ? view : "open";

  const [allTickets, sla] = await Promise.all([
    getTickets({ onlyOpen: tab === "open" }),
    getTicketSlaMap(),
  ]);

  // PRD 4.2's "SLA Overdue / Unanswered" tab. Filtered here rather than in SQL
  // because the flag lives in ticket_sla and both queries are already scoped
  // identically by RLS — a third round trip would buy nothing.
  const tickets =
    tab === "overdue"
      ? allTickets.filter((t) => sla.get(t.id)?.unanswered_overdue || sla.get(t.id)?.sla_state === "breached")
      : allTickets;

  const overdueCount = allTickets.filter(
    (t) => sla.get(t.id)?.unanswered_overdue || sla.get(t.id)?.sla_state === "breached",
  ).length;

  const isTeacher = profile.role === "teacher";
  const scope = isTeacher
    ? "Requests you raised"
    : seesAllTickets(profile.role)
      ? "Every region"
      : "Your region";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>
            confirmation_number
          </span>
          Tickets
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          {scope} · {tab === "overdue" ? "past SLA" : tab === "all" ? "all statuses" : "open only"}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Tab href="/tickets" label="Needs action" active={tab === "open"} />
        <Tab
          href="/tickets?view=overdue"
          label="Overdue"
          active={tab === "overdue"}
          count={overdueCount}
        />
        <Tab href="/tickets?view=all" label="All" active={tab === "all"} />
        {!isTeacher && (
          <Link
            href="/tickets/insights"
            className="ml-auto flex items-center gap-1 rounded-full border-2 border-outline px-4 py-2 font-medium text-on-surface"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>insights</span>
            Insights
          </Link>
        )}
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            inbox
          </span>
          <p className="text-sm text-on-surface-variant">
            {tab === "overdue"
              ? "Nothing is overdue. "
              : tab === "all"
                ? "No tickets yet."
                : "Nothing needs action right now."}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <TicketCard ticket={ticket} sla={sla.get(ticket.id)} showTeacher={!isTeacher} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const PRIORITY_STYLE: Record<string, string> = {
  Urgent: "bg-error-container text-on-error-container",
  High: "bg-warning-container text-on-warning-container",
  Normal: "bg-surface-container-highest text-on-surface-variant",
};

function Tab({
  href,
  label,
  active,
  count,
}: {
  href: string;
  label: string;
  active: boolean;
  count?: number;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-1.5 rounded-full px-4 py-2 font-medium ${
        active ? "bg-primary text-on-primary" : "bg-surface-container-low text-on-surface-variant"
      }`}
    >
      {label}
      {count != null && count > 0 && (
        <span className="rounded-full bg-error px-1.5 text-xs font-bold text-on-error">{count}</span>
      )}
    </Link>
  );
}

const SLA_STYLE: Record<string, string> = {
  breached: "bg-error-container text-on-error-container",
  warning: "bg-warning-container text-on-warning-container",
  on_track: "bg-surface-container-highest text-on-surface-variant",
  met: "bg-tertiary-container text-on-tertiary-container",
  missed: "bg-error-container text-on-error-container",
};

function TicketCard({
  ticket,
  sla,
  showTeacher,
}: {
  ticket: TicketRow;
  sla?: TicketSla;
  showTeacher: boolean;
}) {
  // The stripe follows the SLA once a ticket is late, not the priority: a
  // Normal ticket three days past its target matters more right now than an
  // Urgent one raised ten minutes ago.
  const stripe =
    sla?.sla_state === "breached"
      ? "bg-error"
      : sla?.sla_state === "warning"
        ? "bg-warning"
        : ticket.priority_level === "Urgent"
          ? "bg-error"
          : ticket.priority_level === "High"
            ? "bg-warning"
            : "bg-primary";

  return (
    <Link
      href={`/tickets/${ticket.id}`}
      className="relative block overflow-hidden rounded-2xl bg-surface-container p-4 shadow-sm transition hover:bg-surface-container-high"
    >
      <div className={`absolute inset-y-0 left-0 w-1.5 ${stripe}`} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-on-surface-variant">
            #{ticket.ticket_number} · {ticket.category_type}
          </p>
          <p className="mt-0.5 line-clamp-2 text-sm font-medium text-on-surface">
            {ticket.description}
          </p>
          <p className="mt-1 truncate text-xs text-on-surface-variant">
            {showTeacher && ticket.teacher?.full_name ? `${ticket.teacher.full_name} · ` : ""}
            {ticket.school?.name ?? "No school"} · {formatDateTime(ticket.created_at)}
          </p>
          {sla?.unanswered_overdue && (
            <p className="mt-0.5 text-xs font-semibold text-error">
              No reply for {formatDuration(sla.awaiting_response_minutes)}
            </p>
          )}
          {showTeacher && ticket.assigned_agent?.full_name && (
            <p className="mt-0.5 truncate text-xs text-on-surface-variant">
              Owner: {ticket.assigned_agent.full_name}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${PRIORITY_STYLE[ticket.priority_level]}`}>
            {ticket.priority_level}
          </span>
          <span className="text-xs text-on-surface-variant">{STATUS_LABELS[ticket.status]}</span>
          {sla && sla.sla_state !== "on_track" && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${SLA_STYLE[sla.sla_state]}`}>
              {SLA_LABELS[sla.sla_state]}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
