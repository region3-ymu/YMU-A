import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { getFeedbackOwed, getNextClass, getOpenSession } from "@/lib/attendance/queries";
import { describeDue, dueUrgency } from "@/lib/attendance/feedback-due";
import { formatTime, formatTimeRange, formatWeekdayLong } from "@/lib/format/datetime";
import ClockingClient from "./clocking-client";
import ClockOutButton from "./clock-out-button";

export const metadata: Metadata = { title: "Clocking" };

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "Untitled class";
}

function formatWhen(startAt: string | null, endAt: string | null) {
  if (!startAt) return "Time unavailable";
  return `${formatWeekdayLong(startAt)} · ${formatTimeRange(startAt, endAt)}`;
}

// Three independent regions since migration 0026, instead of the old
// all-or-nothing swap of the whole page for the feedback form:
//
//   1. a hard block, only when feedback is actually overdue;
//   2. "you're clocked in" + Clock out, when a session is open;
//   3. the next class, shown even with feedback pending but not yet due.
//
// The server is still the authority — clock_in() rejects an overdue caller
// regardless of what this page renders. Region 1 is a courtesy so the teacher
// learns why before walking to a school, not the gate itself.
export default async function ClockingPage() {
  await requireRole("teacher");
  const [openSession, nextClass, owed] = await Promise.all([
    getOpenSession(),
    getNextClass(),
    getFeedbackOwed(),
  ]);

  const overdue = owed.filter((o) => dueUrgency(o.feedback_due_at) === "overdue");
  const pending = owed.filter((o) => dueUrgency(o.feedback_due_at) !== "overdue");
  const blocked = overdue.length > 0;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">Clocking</h1>
        <p className="text-sm text-on-surface-variant">
          Clock in at your class. Feedback is due within 24 hours of it ending.
        </p>
      </div>

      {blocked && (
        <section className="rounded-2xl bg-error-container p-5 text-on-error-container">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span className="material-symbols-outlined filled" aria-hidden>lock</span>
            Clock-in locked
          </h2>
          <p className="mt-1 text-sm opacity-90">
            {overdue.length === 1
              ? "One class is past its 24-hour feedback deadline."
              : `${overdue.length} classes are past their 24-hour feedback deadline.`}{" "}
            Submit {overdue.length === 1 ? "it" : "them"} to clock in again.
          </p>
          <ul className="mt-3 grid gap-2">
            {overdue.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/feedback/${item.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-surface-container p-3 text-on-surface shadow-sm transition hover:bg-surface-container-high"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {classTitle(item.event?.summary)}
                    </span>
                    <span className="block truncate text-sm text-on-surface-variant">
                      {item.school?.name ?? "Unmatched school"}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-error">
                    {describeDue(item.feedback_due_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openSession && (
        <section className="relative overflow-hidden rounded-2xl bg-surface-container p-5 shadow-sm">
          <div className="absolute inset-y-0 left-0 w-1.5 bg-tertiary" aria-hidden />
          <p className="text-xs font-semibold uppercase tracking-wide text-tertiary">
            Clocked in
          </p>
          <h2 className="mt-1 text-lg font-semibold text-on-surface">
            {classTitle(openSession.event?.summary)}
          </h2>
          {openSession.school?.name && (
            <p className="mt-0.5 flex items-center gap-1 text-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-base" aria-hidden>location_on</span>
              {openSession.school.name}
            </p>
          )}
          <p className="mt-0.5 text-sm text-on-surface-variant">
            Since {formatTime(openSession.clock_in_at)}
          </p>
          <div className="mt-4">
            <ClockOutButton sessionId={openSession.id} />
          </div>
        </section>
      )}

      {pending.length > 0 && !blocked && (
        <section className="rounded-2xl bg-warning-container p-4 text-on-warning-container">
          <p className="flex items-center gap-2 font-semibold">
            <span className="material-symbols-outlined" aria-hidden>edit_note</span>
            Feedback owed
          </p>
          <p className="mt-1 text-sm opacity-90">
            {pending.length === 1
              ? `${classTitle(pending[0].event?.summary)} — ${describeDue(pending[0].feedback_due_at).toLowerCase()}.`
              : `${pending.length} classes, earliest ${describeDue(pending[0].feedback_due_at).toLowerCase()}.`}
          </p>
          <Link
            href="/feedback"
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold hover:underline"
          >
            Submit now
            <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
          </Link>
        </section>
      )}

      {blocked ? null : nextClass ? (
        <section className="grid gap-4">
          <div className="relative overflow-hidden rounded-2xl bg-surface-container p-5 shadow-sm">
            <div className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden />
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Next class</p>
            <h2 className="mt-1 text-lg font-semibold text-on-surface">{classTitle(nextClass.summary)}</h2>
            <p className="mt-1 flex items-center gap-1 text-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-base" aria-hidden>schedule</span>
              {formatWhen(nextClass.start_at, nextClass.end_at)}
            </p>
            {nextClass.school && (
              <p className="mt-0.5 flex items-center gap-1 text-sm text-on-surface-variant">
                <span className="material-symbols-outlined text-base" aria-hidden>location_on</span>
                {nextClass.school.name}
              </p>
            )}
          </div>

          {nextClass.school ? (
            <ClockingClient
              eventId={nextClass.id}
              className={classTitle(nextClass.summary)}
              startAt={nextClass.start_at}
              school={{
                id: nextClass.school.id,
                name: nextClass.school.name,
                lat: nextClass.school.lat,
                lng: nextClass.school.lng,
                radiusM: nextClass.school.geofence_radius_m,
              }}
            />
          ) : (
            <p className="rounded-2xl bg-warning-container p-4 text-sm text-on-warning-container">
              This class isn&apos;t matched to a school yet, so its location can&apos;t be verified for clock-in.
            </p>
          )}
        </section>
      ) : (
        !openSession && (
          <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
            <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
              event_available
            </span>
            <p className="text-sm text-on-surface-variant">
              You have no upcoming classes to clock into. Check the Schedules tab for your timetable.
            </p>
          </div>
        )
      )}
    </main>
  );
}
