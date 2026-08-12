import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { isManagerRole, seesAllTickets, ROLE_LABELS, type AppRole } from "@/lib/auth/roles";
import { getAssignableAgents, getTicket, getTicketMessages } from "@/lib/tickets/queries";
import { STATUS_LABELS } from "@/lib/tickets/status";
import { formatDateTime, formatTimeRange, formatWeekdayLong } from "@/lib/format/datetime";
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
        {ticket.issue_subcategory && (
          <p className="mt-1 text-sm text-on-surface-variant">
            Reported as: {ISSUE_LABELS[ticket.issue_subcategory] ?? ticket.issue_subcategory}
          </p>
        )}
      </header>

      {/* Everything a manager needs before picking up the phone, in one place.
          Previously this showed the description and little else, so answering
          a ticket meant going and looking the class up. */}
      <section className="rounded-2xl bg-surface-container p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
          Details
        </h2>
        <dl className="mt-2 grid gap-2 text-sm">
          <Row label="Status" value={STATUS_LABELS[ticket.status]} />
          <Row label="Teacher" value={ticket.teacher?.full_name ?? "Unknown"} />
          {/* Contact details go to the people working the ticket only — the
              same rule migration 0027 follows for manager notifications. */}
          {isAgent && ticket.teacher?.phone && (
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <dt className="font-medium text-on-surface-variant">Phone</dt>
              <dd className="min-w-0 break-words">
                <a href={`tel:${ticket.teacher.phone}`} className="font-semibold text-primary hover:underline">
                  {ticket.teacher.phone}
                </a>
              </dd>
            </div>
          )}
          <Row label="School" value={ticket.school?.name ?? "Not matched"} />
          {ticket.school?.address && <Row label="Address" value={ticket.school.address} />}
          <Row label="Region" value={ticket.region ?? "—"} />
          <Row label="Class" value={ticket.event?.summary?.trim() || "—"} />
          {ticket.feedback?.program?.name && (
            <Row label="Program" value={ticket.feedback.program.name} />
          )}
          {ticket.event?.start_at && (
            <>
              <Row label="Day" value={formatWeekdayLong(ticket.event.start_at)} />
              <Row label="Time" value={formatTimeRange(ticket.event.start_at, ticket.event.end_at)} />
            </>
          )}
          <Row label="Owner" value={ticket.assigned_agent?.full_name ?? "Unassigned"} />
          <Row label="Opened" value={formatDateTime(ticket.created_at)} />
          {ticket.first_response_at && (
            <Row label="First reply" value={formatDateTime(ticket.first_response_at)} />
          )}
        </dl>
      </section>

      {/* What the teacher said about the class itself. The ticket description
          is only the problem; this is the context around it. */}
      {ticket.feedback && (
        <section className="rounded-2xl bg-surface-container p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            From their feedback
          </h2>
          <dl className="mt-2 grid gap-2 text-sm">
            <Row label="Engagement" value={ENGAGEMENT_LABELS[ticket.feedback.engagement_level] ?? ticket.feedback.engagement_level} />
            <Row
              label="Quarter goals"
              value={ticket.feedback.quarter_goals_on_track ? "On track" : "Falling behind"}
            />
            {ticket.feedback.objectives_worked.length > 0 && (
              <Row label="Objectives" value={ticket.feedback.objectives_worked.join(", ")} />
            )}
            {/* The calendar detected the wrong program and the teacher said
                so. Worth surfacing to the manager: it is both context for the
                ticket and a hint that this class's title needs a look. */}
            {ticket.feedback.is_custom_program && ticket.feedback.custom_program_name && (
              <Row label="Program (theirs)" value={ticket.feedback.custom_program_name} />
            )}
            {ticket.feedback.custom_notes && (
              <Row label="Worked on" value={ticket.feedback.custom_notes} />
            )}
            {ticket.feedback.open_topic_note && (
              <Row label="Worked on" value={ticket.feedback.open_topic_note} />
            )}
            <Row label="Submitted" value={formatDateTime(ticket.feedback.submitted_at)} />
          </dl>
        </section>
      )}

      {isAgent && (
        <div className="grid min-w-0 gap-5 rounded-2xl bg-surface-container p-4 shadow-sm sm:grid-cols-2">
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

const ISSUE_LABELS: Record<string, string> = {
  attendance: "Attendance / missing students",
  behavior: "Student behavior & management",
  instruments: "Damaged / missing instruments",
  facilities: "Tech, connectivity or facilities",
  cancelled: "Class cancelled on site",
  repertoire: "Repertoire difficulty / sheet music",
  coaching: "Pedagogical support & coaching",
  technique: "Technique / literacy barriers",
};

const ENGAGEMENT_LABELS: Record<string, string> = {
  High: "High engagement & strong output",
  Solid: "Solid / on target",
  Low: "Low engagement / struggling",
};

// A fixed label column with a wrapping value column. The old flex row let a
// long school address push the whole card past the screen edge on a phone.
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words text-on-surface">{value}</dd>
    </div>
  );
}
