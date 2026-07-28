import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { navForRole } from "@/lib/auth/roles";
import { getNextClass, getOpenSession } from "@/lib/attendance/queries";
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

  // Teacher with an unfinished class => re-prompt the feedback gate on login.
  // Only clock-in is blocked (the nav below stays reachable), so this is a
  // prominent prompt rather than a hard redirect.
  const [openSession, nextClass, weekRows] = isTeacher
    ? await Promise.all([
        getOpenSession(),
        getNextClass(),
        (async () => {
          const { from, to } = thisWeekRangeIso();
          return getReportRows({ teacherId: profile.id, from, to });
        })(),
      ])
    : [null, null, []];

  // One weekly bucket for this teacher (rows are already scoped to this week).
  const week: PeriodSummary | null = isTeacher
    ? (bucketReportRows(weekRows, "weekly")[0] ?? null)
    : null;
  const hasWeekStats = week != null && (week.scheduledCount > 0 || week.hoursWorked > 0);
  const onTimePct =
    week && week.scheduledCount > 0 ? Math.round((week.onTimeCount / week.scheduledCount) * 100) : null;

  // The Clocking tile reflects which action is actually available right now:
  // with an open session, clocking in is blocked, so the tile becomes the
  // "Clock out" entry point instead of restating "Clocking".
  const nav = navForRole(profile.role, profile.is_app_admin).map((item) =>
    item.href === "/clocking" && openSession
      ? { ...item, label: "Clock out", note: "Submit feedback to finish" }
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

      {openSession && (
        <Link
          href="/feedback"
          className="block rounded-2xl bg-error-container p-4 text-on-error-container shadow-sm transition-transform active:scale-[0.99]"
        >
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-error" aria-hidden>
              warning
            </span>
            <div className="flex-1">
              <p className="font-bold">Feedback required</p>
              <p className="mt-0.5 text-sm opacity-90">
                You&apos;re still clocked in to{" "}
                <span className="font-semibold">
                  {openSession.event?.summary?.trim() || "your last class"}
                </span>
                . Submit your feedback to clock out.
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

      {/* Gradient "Next up" hero (Base44) — the teacher's soonest clockable
          class. Hidden while an open session blocks clock-in. */}
      {isTeacher && !openSession && nextClass && (
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary to-[#7c3aed] p-5 text-white shadow-lg">
          <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10" aria-hidden />
          <p className="text-xs font-semibold uppercase tracking-wide text-white/80">Next up</p>
          <h2 className="mt-1 text-2xl font-bold">{classTitle(nextClass.summary)}</h2>
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
