import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { getOpenSession } from "@/lib/attendance/queries";
import { getFeedbackConfig } from "@/lib/attendance/relay-feedback";
import FeedbackForm from "./feedback-form";

export const metadata: Metadata = { title: "Feedback" };

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "Untitled class";
}

export default async function FeedbackPage() {
  const profile = await requireRole("teacher");
  const openSession = await getOpenSession();
  const feedbackConfig = getFeedbackConfig();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">Class feedback</h1>
        <p className="text-sm text-on-surface-variant">Feedback clocks you out and is required before your next class.</p>
      </div>

      {openSession ? (
        <FeedbackForm
          session={{
            id: openSession.id,
            className: classTitle(openSession.event?.summary),
            schoolName: openSession.school?.name ?? null,
            teacherName: profile.full_name,
            teacherId: profile.id,
            clockInAt: openSession.clock_in_at,
            status: openSession.clock_in_status,
          }}
          feedbackConfig={feedbackConfig}
        />
      ) : (
        <div className="rounded-2xl bg-surface-container p-5 shadow-sm">
          <p className="font-semibold text-on-surface">Nothing to submit</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            You&apos;re not clocked into a class right now, so there&apos;s no feedback pending.
          </p>
          <Link
            href="/clocking"
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            Go to Clocking
            <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
          </Link>
        </div>
      )}
    </main>
  );
}
