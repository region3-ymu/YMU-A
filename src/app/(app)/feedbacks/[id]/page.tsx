import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { FEEDBACK_READER_ROLES } from "@/lib/auth/roles";
import { getFeedbackById, getTicketForFeedback } from "@/lib/feedback/queries";
import { ENGAGEMENT_LABELS } from "@/lib/feedback/program-match";
import { getReportRoster } from "@/lib/reports/queries";
import { formatDateTime } from "@/lib/format/datetime";
import { STATUS_LABELS } from "@/lib/tickets/status";

export const metadata: Metadata = { title: "Feedback" };

export default async function FeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(...FEEDBACK_READER_ROLES);
  const { id } = await params;

  const feedback = await getFeedbackById(id);
  // Out of region for a Regional Manager looks exactly like "does not exist",
  // which is the correct thing to tell them.
  if (!feedback) notFound();

  const [ticket, roster] = await Promise.all([
    getTicketForFeedback(feedback.id),
    getReportRoster(true),
  ]);
  const teacherName =
    roster.find((t) => t.id === feedback.teacher_id)?.full_name ?? "Unknown teacher";

  const cancelled = feedback.engagement_level === "Canceled";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link
          href="/feedbacks"
          className="flex items-center gap-1 text-sm text-on-surface-variant hover:underline"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>
          Feedbacks
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-on-surface">{teacherName}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          {feedback.event?.summary ?? feedback.program?.name ?? "Class"}
          {feedback.school?.name ? ` · ${feedback.school.name}` : ""}
          {feedback.event?.start_at ? ` · ${formatDateTime(feedback.event.start_at)}` : ""}
        </p>
      </div>

      <section className="rounded-2xl bg-surface-container p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
          What they reported
        </h2>
        <dl className="mt-2 grid gap-2 text-sm">
          <Row
            label="Engagement"
            value={ENGAGEMENT_LABELS[feedback.engagement_level] ?? feedback.engagement_level}
          />

          {cancelled ? (
            <Row
              label="Cancellation"
              value={feedback.cancellation_notes ?? "No notes given."}
            />
          ) : (
            <>
              {feedback.quarter_goals_on_track !== null && (
                <Row
                  label="Quarter goals"
                  value={feedback.quarter_goals_on_track ? "On track" : "Falling behind"}
                />
              )}
              {feedback.program?.name && <Row label="Program" value={feedback.program.name} />}
              {feedback.objectives_worked.length > 0 && (
                <Row label="Objectives" value={feedback.objectives_worked.join(", ")} />
              )}
              {/* The calendar detected the wrong program and the teacher said
                  so. Worth surfacing: it is both context and a hint that this
                  class's calendar title needs a look. */}
              {feedback.is_custom_program && feedback.custom_program_name && (
                <Row label="Program (theirs)" value={feedback.custom_program_name} />
              )}
              {feedback.custom_notes && <Row label="Worked on" value={feedback.custom_notes} />}
              {/* Only ever set by the pillar-era form, before the objective
                  selector. Kept so older classes still read back in full. */}
              {feedback.open_topic_note && (
                <Row label="Worked on" value={feedback.open_topic_note} />
              )}
            </>
          )}

          <Row label="Submitted" value={formatDateTime(feedback.submitted_at)} />
        </dl>
      </section>

      {ticket && (
        <section className="rounded-2xl bg-surface-container p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            Ticket this raised
          </h2>
          <Link
            href={`/tickets/${ticket.id}`}
            className="mt-2 inline-flex items-center gap-2 font-semibold text-primary hover:underline"
          >
            #{ticket.ticket_number} · {STATUS_LABELS[ticket.status as keyof typeof STATUS_LABELS] ?? ticket.status}
            <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
          </Link>
        </section>
      )}
    </main>
  );
}

// A fixed label column with a wrapping value column, matching the ticket
// detail page — long notes must not push the card past a phone's edge.
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words text-on-surface">{value}</dd>
    </div>
  );
}
