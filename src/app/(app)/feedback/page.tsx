import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { getFeedbackOwed, type OwedFeedback } from "@/lib/attendance/queries";
import { describeDue, dueUrgency } from "@/lib/attendance/feedback-due";
import { formatDate, formatTimeRange } from "@/lib/format/datetime";

export const metadata: Metadata = { title: "Feedback" };

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "Untitled class";
}

// The teacher-facing counterpart to /flags. Managers have had an escalation
// list since Phase 5; before migration 0026 teachers had nothing equivalent,
// because feedback could only ever be owed for one class at a time (the open
// session). With a 24-hour window several can stack up, so they need somewhere
// to see the whole list and its deadlines.
export default async function FeedbackPage() {
  await requireRole("teacher");
  const owed = await getFeedbackOwed();
  const overdueCount = owed.filter((o) => dueUrgency(o.feedback_due_at) === "overdue").length;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">Class feedback</h1>
        <p className="text-sm text-on-surface-variant">
          You have 24 hours after each class to submit its feedback.
        </p>
      </div>

      {overdueCount > 0 && (
        <div className="rounded-2xl bg-error-container p-4 text-on-error-container">
          <p className="flex items-center gap-2 font-semibold">
            <span className="material-symbols-outlined filled" aria-hidden>lock</span>
            Clock-in is locked
          </p>
          <p className="mt-1 text-sm opacity-90">
            {overdueCount === 1
              ? "One class is past its 24-hour deadline. Submit it to clock in again."
              : `${overdueCount} classes are past their 24-hour deadline. Submit them all to clock in again.`}
          </p>
        </div>
      )}

      {owed.length === 0 ? (
        <div className="rounded-2xl bg-surface-container p-5 shadow-sm">
          <p className="font-semibold text-on-surface">You&apos;re all caught up</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            No classes are waiting on feedback.
          </p>
          <Link
            href="/clocking"
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            Go to Clocking
            <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3">
          {owed.map((item) => (
            <li key={item.id}>
              <OwedCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const URGENCY_CHIP: Record<string, string> = {
  overdue: "bg-error-container text-on-error-container",
  soon: "bg-warning-container text-on-warning-container",
  ok: "bg-surface-container-highest text-on-surface-variant",
  none: "bg-surface-container-highest text-on-surface-variant",
};

function OwedCard({ item }: { item: OwedFeedback }) {
  const urgency = dueUrgency(item.feedback_due_at);
  const stripe = urgency === "overdue" ? "bg-error" : urgency === "soon" ? "bg-warning" : "bg-primary";

  return (
    <Link
      href={`/feedback/${item.id}`}
      className="relative block overflow-hidden rounded-2xl bg-surface-container p-4 shadow-sm transition hover:bg-surface-container-high"
    >
      <div className={`absolute inset-y-0 left-0 w-1.5 ${stripe}`} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-on-surface">
            {classTitle(item.event?.summary)}
          </h2>
          {item.school?.name && (
            <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-base" aria-hidden>location_on</span>
              {item.school.name}
            </p>
          )}
          <p className="mt-0.5 text-sm text-on-surface-variant">
            {formatDate(item.clock_in_at)}
            {item.event?.start_at
              ? ` · ${formatTimeRange(item.event.start_at, item.event.end_at)}`
              : ""}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${URGENCY_CHIP[urgency]}`}
        >
          {describeDue(item.feedback_due_at)}
        </span>
      </div>
    </Link>
  );
}
