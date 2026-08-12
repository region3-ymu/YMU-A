import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { seesAllTickets } from "@/lib/auth/roles";
import { getTickets, type TicketRow } from "@/lib/tickets/queries";
import { STATUS_LABELS } from "@/lib/tickets/status";
import { formatDateTime } from "@/lib/format/datetime";

export const metadata: Metadata = { title: "Tickets" };

// Replaces the Zoho Desk inbox. Scoping is entirely RLS (migration 0030):
// a teacher sees the tickets they raised, a Regional Manager sees their
// region's, and the Academic Manager / OM / CPO see everything.
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const profile = await requireProfile();
  const { all } = await searchParams;
  const showAll = all === "1";
  const tickets = await getTickets({ onlyOpen: !showAll });

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
          {scope} · {showAll ? "all statuses" : "open only"}
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        <Link
          href="/tickets"
          className={`rounded-full px-4 py-2 font-medium ${
            showAll ? "bg-surface-container-low text-on-surface-variant" : "bg-primary text-on-primary"
          }`}
        >
          Needs action
        </Link>
        <Link
          href="/tickets?all=1"
          className={`rounded-full px-4 py-2 font-medium ${
            showAll ? "bg-primary text-on-primary" : "bg-surface-container-low text-on-surface-variant"
          }`}
        >
          All
        </Link>
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            inbox
          </span>
          <p className="text-sm text-on-surface-variant">
            {showAll ? "No tickets yet." : "Nothing needs action right now."}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <TicketCard ticket={ticket} showTeacher={!isTeacher} />
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

function TicketCard({ ticket, showTeacher }: { ticket: TicketRow; showTeacher: boolean }) {
  const stripe =
    ticket.priority_level === "Urgent"
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
        </div>
      </div>
    </Link>
  );
}
