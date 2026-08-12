import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { isManagerRole, seesAllTickets, ROLE_LABELS, type AppRole } from "@/lib/auth/roles";
import { getAssignableAgents, getTicket, getTicketMessages } from "@/lib/tickets/queries";
import { STATUS_LABELS } from "@/lib/tickets/status";
import { formatDateTime } from "@/lib/format/datetime";
import { ReassignControl, ReplyBox, StatusControl } from "./ticket-controls";

export const metadata: Metadata = { title: "Ticket" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireProfile();

  // RLS decides visibility. A ticket outside the caller's scope simply returns
  // nothing, which is indistinguishable from one that doesn't exist — exactly
  // the behaviour we want.
  const ticket = await getTicket(id);
  if (!ticket) notFound();

  const isAgent =
    isManagerRole(profile.role) || seesAllTickets(profile.role) || ticket.assigned_agent_id === profile.id;

  const [messages, agents] = await Promise.all([
    getTicketMessages(id),
    isAgent ? getAssignableAgents() : Promise.resolve([]),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <Link href="/tickets" className="flex items-center gap-1 text-sm text-on-surface-variant hover:underline">
        <span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>
        All tickets
      </Link>

      <header className="rounded-2xl bg-surface-container p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          #{ticket.ticket_number} · {ticket.category_type} · {ticket.priority_level}
        </p>
        <h1 className="mt-1 text-lg font-semibold text-on-surface">{ticket.description}</h1>
        <dl className="mt-3 grid gap-1 text-sm text-on-surface-variant">
          <Row label="Status" value={STATUS_LABELS[ticket.status]} />
          <Row label="Raised by" value={ticket.teacher?.full_name ?? "Unknown"} />
          {/* Contact details go to the people working the ticket only — the
              same rule migration 0027 follows for manager notifications. */}
          {isAgent && ticket.teacher?.phone && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-medium">Phone</dt>
              <dd>
                <a href={`tel:${ticket.teacher.phone}`} className="text-primary hover:underline">
                  {ticket.teacher.phone}
                </a>
              </dd>
            </div>
          )}
          <Row label="School" value={ticket.school?.name ?? "Not matched"} />
          <Row label="Region" value={ticket.region ?? "—"} />
          <Row label="Owner" value={ticket.assigned_agent?.full_name ?? "Unassigned"} />
          <Row label="Opened" value={formatDateTime(ticket.created_at)} />
        </dl>
      </header>

      {isAgent && (
        <div className="grid gap-4 rounded-2xl bg-surface-container p-5 shadow-sm sm:grid-cols-2">
          <StatusControl
            ticketId={ticket.id}
            current={ticket.status}
            currentRootCause={ticket.root_cause_category}
          />
          <ReassignControl
            ticketId={ticket.id}
            currentAgentId={ticket.assigned_agent_id}
            agents={agents.map((a) => ({
              ...a,
              full_name: `${a.full_name} (${ROLE_LABELS[a.role as AppRole] ?? a.role})`,
            }))}
          />
        </div>
      )}

      <section className="grid gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
          Conversation
        </h2>
        {messages.length === 0 ? (
          <p className="rounded-2xl bg-surface-container p-4 text-sm text-on-surface-variant">
            Nothing yet.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className={`rounded-2xl p-4 shadow-sm ${
                  m.is_internal_note
                    ? "bg-surface-container-highest"
                    : m.sender_id === ticket.assigned_agent_id
                      ? "bg-primary-container text-on-primary-container"
                      : "bg-surface-container"
                }`}
              >
                <p className="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
                  {m.sender?.full_name ?? "System"}
                  {m.is_internal_note && (
                    <span className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] uppercase">
                      Internal
                    </span>
                  )}
                  <span className="font-normal">{formatDateTime(m.created_at)}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{m.message_body}</p>
              </li>
            ))}
          </ul>
        )}
        <ReplyBox ticketId={ticket.id} canWriteNote={isAgent} />
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 font-medium">{label}</dt>
      <dd className="text-on-surface">{value}</dd>
    </div>
  );
}
