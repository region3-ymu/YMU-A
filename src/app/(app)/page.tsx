import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { navForRole } from "@/lib/auth/roles";
import { getFeedbackOwed, getNextClass, getOpenSession } from "@/lib/attendance/queries";
import { describeDue, dueUrgency } from "@/lib/attendance/feedback-due";
import { getReportRows } from "@/lib/reports/queries";
import { bucketReportRows } from "@/lib/reports/aggregate";
import type { PeriodSummary } from "@/lib/reports/types";
import { formatTime, formatWeekdayLong } from "@/lib/format/datetime";
import PushOnboardingPrompt from "@/components/push-onboarding-prompt";

// Rotating tint for the bento tile icons (Stitch look — each tile's icon sits
// in a soft colored disc). Indexed round-robin across the menu items.
const TILE_TINTS = [
  "bg-primary-container text-on-primary-container",
  "bg-tertiary-container text-on-tertiary-container",
  "bg-secondary-container text-on-secondary-container",
  "bg-surface-variant text-on-surface-variant",
];

const DAY_MS = 24 * 60 * 60 * 1000;

function classTitle(summary: string | null | undefined) {
  return summary?.trim() || "your next class";
}

// Monday-start week containing now, in UTC — matches the reports aggregate's
// week convention so the "this week" bucket lines up with the Reports tab.
function thisWeekRangeIso(): { from: string; to: string } {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dow = new Date(midnight).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const weekStart = midnight - daysSinceMonday * DAY_MS;
  return { from: new Date(weekStart).toISOString(), to: new Date(weekStart + 7 * DAY_MS).toISOString() };
}

export default async function Home() {
  const profile = await requireProfile();
  const isTeacher = profile.role === "teacher";

  // Teacher with feedback outstanding => re-prompt on login. Since migration
  // 0026 this comes in two flavours: owed-but-in-window (a nudge) and overdue
  // (clock-in is genuinely locked). Only clock-in is ever blocked — the nav
  // below stays reachable — so both are prompts, not redirects.
  const [openSession, nextClass, weekRows, owed] = isTeacher
    ? await Promise.all([
        getOpenSession(),
        getNextClass(),
        (async () => {
          const { from, to } = thisWeekRangeIso();
          return getReportRows({ teacherId: profile.id, from, to });
        })(),
        getFeedbackOwed(),
      ])
    : [null, null, [], []];

  const overdueOwed = owed.filter((o) => dueUrgency(o.feedback_due_at) === "overdue");
  const pendingOwed = owed.filter((o) => dueUrgency(o.feedback_due_at) !== "overdue");
  const clockInLocked = overdueOwed.length > 0;

  // One weekly bucket for this teacher (rows are already scoped to this week).
  const week: PeriodSummary | null = isTeacher
    ? (bucketReportRows(weekRows, "weekly")[0] ?? null)
    : null;
  const hasWeekStats = week != null && (week.scheduledCount > 0 || week.hoursWorked > 0);
  const onTimePct =
    week && week.scheduledCount > 0 ? Math.round((week.onTimeCount / week.scheduledCount) * 100) : null;

  // The Clocking tile just reflects state now — there is no clock-out step to
  // point at (YMU 2026-08-12).
  const nav = navForRole(profile.role, profile.is_app_admin).map((item) =>
    item.href === "/clocking" && openSession
      ? { ...item, label: "Clocking", note: "You're clocked in" }
      : item,
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4">
      <header className="pt-2">
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          Hi, {profile.full_name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-on-surface-variant">
          {isTeacher && nextClass
            ? `You teach ${classTitle(nextClass.summary)}${nextClass.school ? ` at ${nextClass.school.name}` : ""}.`
            : "Young Musicians Unite — Attendance"}
        </p>
      </header>

      {clockInLocked && (
        <Link
          href="/feedback"
          className="block rounded-2xl bg-error-container p-4 text-on-error-container shadow-sm transition-transform active:scale-[0.99]"
        >
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-error" aria-hidden>
              lock
            </span>
            <div className="flex-1">
              <p className="font-bold">Clock-in locked</p>
              <p className="mt-0.5 text-sm opacity-90">
                {overdueOwed.length === 1 ? (
                  <>
                    <span className="font-semibold">
                      {overdueOwed[0].event?.summary?.trim() || "A class"}
                    </span>{" "}
                    is past its 24-hour feedback deadline.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">{overdueOwed.length} classes</span> are past
                    their 24-hour feedback deadline.
                  </>
                )}{" "}
                Submit {overdueOwed.length === 1 ? "it" : "them"} to clock in again.
              </p>
              <span className="mt-3 inline-flex items-center gap-1 rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error">
                Complete now
                <span className="material-symbols-outlined text-base" aria-hidden>
                  arrow_forward
                </span>
              </span>
            </div>
          </div>
        </Link>
      )}

      {!clockInLocked && pendingOwed.length > 0 && (
        // Red and loud even though the deadline has NOT passed yet. The
        // warning-coloured version was too easy to scroll past, and by the
        // time it turns into the locked state the teacher has already lost
        // the ability to clock in — which is the outcome this exists to
        // prevent, not announce.
        <div className="rounded-2xl bg-error-container p-5 text-on-error-container shadow-sm">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-3xl text-error" aria-hidden>
              assignment_late
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xl font-bold leading-tight">
                Feedback owed for {pendingOwed.length}{" "}
                {pendingOwed.length === 1 ? "class" : "classes"}
              </p>
              <p className="mt-1 text-sm opacity-90">
                Earliest {describeDue(pendingOwed[0].feedback_due_at).toLowerCase()}. After that you
                can&apos;t clock in anywhere.
              </p>
            </div>
          </div>
          <ul className="mt-3 grid gap-2">
            {/* Straight into the form for a specific class — one tap from
                here to writing, instead of landing on a list first. */}
            {pendingOwed.slice(0, 3).map((item) => (
              <li key={item.id}>
                <Link
                  href={`/feedback/${item.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-surface-container p-3 text-on-surface shadow-sm transition active:scale-[0.99]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {item.event?.summary?.trim() || "Untitled class"}
                    </span>
                    <span className="block truncate text-xs text-on-surface-variant">
                      {item.school?.name ?? "Unmatched school"} ·{" "}
                      {describeDue(item.feedback_due_at)}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-error px-4 py-2 text-sm font-bold text-on-error">
                    Submit now
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {pendingOwed.length > 3 && (
            <Link href="/feedback" className="mt-2 inline-block text-sm font-semibold underline">
              See all {pendingOwed.length}
            </Link>
          )}
        </div>
      )}

      {/* Gradient "Next up" hero (Base44) — the teacher's soonest clockable
          class. Hidden only when clock-in is genuinely locked; feedback merely
          pending no longer hides it, which is the whole point of the window. */}
      {isTeacher && !clockInLocked && nextClass && (
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-[#7c3aed] p-4 text-white shadow-md">
          <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/10" aria-hidden />
          <p className="text-xs font-semibold uppercase tracking-wide text-white/80">Next up today</p>
          <h2 className="mt-0.5 text-lg font-bold">{classTitle(nextClass.summary)}</h2>
          {nextClass.school && (
            <p className="mt-1 flex items-center gap-1 text-sm text-white/90">
              <span className="material-symbols-outlined text-base" aria-hidden>location_on</span>
              {nextClass.school.name}
            </p>
          )}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-white/90">
              {nextClass.start_at ? `${formatWeekdayLong(nextClass.start_at)} · ` : ""}
              {formatTime(nextClass.start_at)}
              {nextClass.end_at ? ` – ${formatTime(nextClass.end_at)}` : ""}
            </span>
            <Link
              href="/clocking"
              className="flex shrink-0 items-center gap-1 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-primary shadow-sm transition-transform active:scale-[0.97]"
            >
              Clock in
              <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
            </Link>
          </div>
        </div>
      )}

      <PushOnboardingPrompt />

      <ul className="grid grid-cols-2 gap-3">
        {nav.map((item, i) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex h-full flex-col gap-6 rounded-2xl bg-surface-container p-4 shadow-sm transition-transform active:scale-[0.98]"
            >
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-full shadow-sm ${TILE_TINTS[i % TILE_TINTS.length]}`}
              >
                <span className="material-symbols-outlined" aria-hidden>
                  {item.icon}
                </span>
              </span>
              <span className="mt-auto">
                <span className="block font-bold text-on-surface">
                  {item.label}
                </span>
                <span className="mt-0.5 block text-sm text-on-surface-variant">
                  {item.note}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {/* "This week" glanceable stats (Base44) — teacher only. */}
      {isTeacher && hasWeekStats && week && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            This week
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
              <p className="text-3xl font-bold text-primary">{week.hoursWorked}</p>
              <p className="mt-0.5 text-sm text-on-surface-variant">Hours</p>
            </div>
            <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
              <p className="text-3xl font-bold text-tertiary">{onTimePct != null ? `${onTimePct}%` : "—"}</p>
              <p className="mt-0.5 text-sm text-on-surface-variant">On-time</p>
            </div>
            <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
              <p className="text-3xl font-bold text-on-surface">
                {week.attendanceRatePct != null ? `${week.attendanceRatePct}%` : "—"}
              </p>
              <p className="mt-0.5 text-sm text-on-surface-variant">Attendance</p>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
