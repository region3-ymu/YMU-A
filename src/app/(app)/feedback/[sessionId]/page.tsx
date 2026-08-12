import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { getOwedFeedbackById } from "@/lib/attendance/queries";
import { getFeedbackFormData } from "@/lib/feedback/queries";
import { describeDue, dueUrgency } from "@/lib/attendance/feedback-due";
import { formatDate, formatTimeRange } from "@/lib/format/datetime";
import ClassFeedbackForm from "../class-feedback-form";

export const metadata: Metadata = { title: "Feedback" };

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "Untitled class";
}

// The native four-section form (PRD Module A), which replaces the Zoho embed
// and the PD-week relay form. ROUTE_ROLES matches by prefix, so "/feedback"
// already covers this route; requireRole below is the authoritative check.
export default async function FeedbackSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  await requireRole("teacher");
  const owed = await getOwedFeedbackById(sessionId);

  // Either the id isn't the caller's (RLS returned nothing) or its feedback is
  // already in. Both are "nothing to do here", and neither should leak which.
  if (!owed) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) notFound();
    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
        <div className="rounded-2xl bg-surface-container p-5 shadow-sm">
          <p className="font-semibold text-on-surface">Nothing to submit</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            This class either already has its feedback or isn&apos;t one of yours.
          </p>
          <Link
            href="/feedback"
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            Back to feedback
            <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
          </Link>
        </div>
      </main>
    );
  }

  const summary = classTitle(owed.event?.summary);
  const { programs, guessed, topics } = await getFeedbackFormData(owed.event?.summary);
  const urgency = dueUrgency(owed.feedback_due_at);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">{summary}</h1>
        <p className="text-sm text-on-surface-variant">
          {formatDate(owed.clock_in_at)}
          {owed.event?.start_at ? ` · ${formatTimeRange(owed.event.start_at, owed.event.end_at)}` : ""}
          {owed.school?.name ? ` · ${owed.school.name}` : ""}
        </p>
        <p
          className={`mt-1 text-sm font-medium ${
            urgency === "overdue" ? "text-error" : urgency === "soon" ? "text-warning" : "text-on-surface-variant"
          }`}
        >
          {describeDue(owed.feedback_due_at)}
        </p>
      </div>

      <ClassFeedbackForm
        sessionId={owed.id}
        className={summary}
        schoolName={owed.school?.name ?? null}
        programs={programs}
        guessedProgram={guessed}
        initialTopics={topics}
      />

      {urgency !== "overdue" && (
        <p className="text-center">
          <Link
            href="/feedback"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Do this later
          </Link>
        </p>
      )}
    </main>
  );
}
