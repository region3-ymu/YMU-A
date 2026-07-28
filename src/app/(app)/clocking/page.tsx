import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import { getNextClass, getOpenSession } from "@/lib/attendance/queries";
import { getFeedbackConfig } from "@/lib/attendance/relay-feedback";
import FeedbackForm from "../feedback/feedback-form";
import ClockingClient from "./clocking-client";

export const metadata: Metadata = { title: "Clocking" };

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "Untitled class";
}

function formatWhen(startAt: string | null, endAt: string | null) {
  if (!startAt) return "Time unavailable";
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : null;
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time.format(start)}${end ? `–${time.format(end)}` : ""}`;
}

export default async function ClockingPage() {
  const profile = await requireRole("teacher");
  const [openSession, nextClass] = await Promise.all([getOpenSession(), getNextClass()]);
  const feedbackConfig = getFeedbackConfig();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">Clocking</h1>
        <p className="text-sm text-on-surface-variant">Clock in at your class, clock out with feedback.</p>
      </div>

      {openSession ? (
        // Clocked in => feedback is owed. The clock-in flow is intentionally
        // not offered here: an open session blocks a new clock-in until this
        // form is submitted.
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
      ) : nextClass ? (
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
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            event_available
          </span>
          <p className="text-sm text-on-surface-variant">
            You have no upcoming classes to clock into. Check the Schedules tab for your timetable.
          </p>
        </div>
      )}
    </main>
  );
}
