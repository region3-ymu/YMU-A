import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { getFeedbackOwed, type OwedFeedback } from "@/lib/attendance/queries";
import { getSubmittedFeedback, type SubmittedFeedback } from "@/lib/feedback/queries";
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
  const [owed, submitted] = await Promise.all([getFeedbackOwed(), getSubmittedFeedback()]);
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
        <ul className="grid grid-cols-1 gap-3">
          {/* grid-cols-1, not a bare `grid`: an implicit grid column is
              `auto`, which refuses to shrink below its content's intrinsic
              width, so the card grew past the viewport and the deadline chip
              fell off the right edge on a phone. Tailwind's grid-cols-1 is
              minmax(0, 1fr), which is what lets `truncate` actually
              truncate. */}
          {owed.map((item) => (
            <li key={item.id}>
              <OwedCard item={item} />
            </li>
          ))}
        </ul>
      )}

      {/* What they already said. Requested so a teacher can look back at their
          own answers — before this the form was write-only, and once submitted
          the answers were visible to managers but not to their author. */}
      {submitted.length > 0 && (
        <section className="mt-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            Already submitted
          </h2>
          <ul className="mt-2 grid grid-cols-1 gap-2">
            {submitted.map((item) => (
              <li key={item.id}>
                <SubmittedCard item={item} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

const ENGAGEMENT_LABELS: Record<string, string> = {
  High: "High engagement",
  Solid: "Solid / on target",
  Low: "Low engagement",
};

// Collapsed by default: the list is a reference, not a feed. A teacher opens
// the one class they are trying to remember, not all twenty-five.
function SubmittedCard({ item }: { item: SubmittedFeedback }) {
  return (
    <details className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <summary className="cursor-pointer list-none">
        <span className="block truncate font-medium text-on-surface">
          {item.event?.summary?.trim() || "Untitled class"}
        </span>
        <span className="mt-0.5 block truncate text-xs text-on-surface-variant">
          {item.school?.name ?? "—"} · {formatDate(item.submitted_at)}
          {item.has_issue ? " · reported an issue" : ""}
        </span>
      </summary>
      <dl className="mt-3 grid gap-1.5 text-sm">
        {item.program?.name && <Answer label="Program" value={item.program.name} />}
        <Answer
          label="Engagement"
          value={ENGAGEMENT_LABELS[item.engagement_level] ?? item.engagement_level}
        />
        <Answer
          label="Quarter goals"
          value={item.quarter_goals_on_track ? "On track" : "Falling behind"}
        />
        {item.objectives_worked.length > 0 && (
          <Answer label="Objectives" value={item.objectives_worked.join(", ")} />
        )}
        {item.is_custom_program && item.custom_program_name && (
          <Answer label="Program (yours)" value={item.custom_program_name} />
        )}
        {item.custom_notes && <Answer label="Worked on" value={item.custom_notes} />}
        {/* Only ever set by the pillar-era form. Still shown so a teacher can
            look back at a class from before the objective selector. */}
        {item.open_topic_note && <Answer label="Worked on" value={item.open_topic_note} />}
      </dl>
    </details>
  );
}

function Answer({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words text-on-surface">{value}</dd>
    </div>
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
