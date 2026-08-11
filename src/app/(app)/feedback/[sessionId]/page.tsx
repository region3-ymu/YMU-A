import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { getOwedFeedbackById } from "@/lib/attendance/queries";
import { getFeedbackConfig } from "@/lib/attendance/relay-feedback";
import FeedbackForm from "../feedback-form";

export const metadata: Metadata = { title: "Feedback" };

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "Untitled class";
}

// The form for one specific owed class. /feedback is the list; this is an
// item. Note that ROUTE_ROLES matches by prefix (rolesAllowedForPath in
// lib/auth/roles.ts), so "/feedback" already covers this route — no change
// needed there. requireRole below is the authoritative check either way.
export default async function FeedbackSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const profile = await requireRole("teacher");
  const owed = await getOwedFeedbackById(sessionId);

  // Either the id isn't the caller's (RLS returned nothing) or its feedback is
  // already in. Both are "there's nothing to do here", and neither should leak
  // which one it was.
  if (!owed) {
    const looksLikeId = /^[0-9a-f-]{36}$/i.test(sessionId);
    if (!looksLikeId) notFound();
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

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <FeedbackForm
        session={{
          id: owed.id,
          className: classTitle(owed.event?.summary),
          schoolName: owed.school?.name ?? null,
          teacherName: profile.full_name,
          teacherId: profile.id,
          clockInAt: owed.clock_in_at,
          status: owed.clock_in_status,
        }}
        feedbackConfig={getFeedbackConfig()}
        dueAt={owed.feedback_due_at}
      />
    </main>
  );
}
