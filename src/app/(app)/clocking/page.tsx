import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import { getNextClass, getOpenSession } from "@/lib/attendance/queries";
import { getZohoFeedbackConfig } from "@/lib/attendance/zoho-feedback";
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
  const zohoConfig = getZohoFeedbackConfig();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Clocking</h1>
        <p className="text-sm opacity-70">Clock in at your class, clock out with feedback.</p>
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
          zohoConfig={zohoConfig}
        />
      ) : nextClass ? (
        <section className="grid gap-4">
          <div className="rounded-2xl border border-foreground/10 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Next class</p>
            <h2 className="mt-1 text-lg font-semibold">{classTitle(nextClass.summary)}</h2>
            <p className="mt-0.5 text-sm opacity-80">{formatWhen(nextClass.start_at, nextClass.end_at)}</p>
            {nextClass.school && <p className="mt-0.5 text-sm opacity-80">{nextClass.school.name}</p>}
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
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
              This class isn&apos;t matched to a school yet, so its location can&apos;t be verified for clock-in.
            </p>
          )}
        </section>
      ) : (
        <p className="rounded-xl border border-foreground/10 p-5 text-sm opacity-80">
          You have no upcoming classes to clock into. Check the Schedules tab for your timetable.
        </p>
      )}
    </main>
  );
}
