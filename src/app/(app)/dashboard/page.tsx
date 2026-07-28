import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import SearchBox from "@/components/search-box";
import { getStuckSessionFlags } from "@/lib/attendance/stuck-sessions";
import { getReportRoster } from "@/lib/reports/queries";
import {
  getCalendarSyncHealth,
  getOpenLateFlags,
  getOpenSessions,
  getRecentNotificationFailureCount,
  getTodayAttendanceRows,
  getUpcomingClasses,
} from "./queries";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const profile = await requireRole(...MANAGER_ROLES);

  const [openSessions, lateFlags, stuckFeedback, syncFailures, notificationFailures, todayRows, upcoming, roster] =
    await Promise.all([
      getOpenSessions(),
      getOpenLateFlags(),
      getStuckSessionFlags(),
      getCalendarSyncHealth(),
      getRecentNotificationFailureCount(),
      getTodayAttendanceRows(),
      getUpcomingClasses(),
      getReportRoster(true),
    ]);

  const nameById = new Map(roster.map((t) => [t.id, t.full_name]));
  const scheduledTeacherIds = new Set(todayRows.map((r) => r.teacher_id));
  const missing = todayRows.filter((r) => r.attendance_status === "missed");

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <header className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
          aria-hidden
        >
          <span className="material-symbols-outlined">dashboard</span>
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">Manager Dashboard</h1>
          <p className="mt-1 text-sm text-on-surface-variant">Today at a glance.</p>
        </div>
      </header>

      <SearchBox />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Scheduled today" value={scheduledTeacherIds.size} note={`${todayRows.length} classes`} />
        <StatCard label="Clocked in now" value={openSessions.length} />
        <StatCard label="Late" value={lateFlags.length} warn={lateFlags.length > 0} />
        <StatCard label="Missing clock-ins" value={missing.length} warn={missing.length > 0} />
        <StatCard label="Pending feedback" value={openSessions.length} />
        <StatCard label="Upcoming classes" value={upcoming.length} />
        <StatCard
          label="Stuck feedback sessions"
          value={stuckFeedback.length}
          warn={stuckFeedback.length > 0}
        />
        <StatCard
          label="Calendar sync"
          value={syncFailures.length}
          note={syncFailures.length > 0 ? "calendars failing" : "all healthy"}
          warn={syncFailures.length > 0}
        />
        <StatCard
          label="Notification failures (24h)"
          value={notificationFailures}
          warn={notificationFailures > 0}
        />
      </div>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>my_location</span>
          Clocked in now &amp; pending feedback
        </h2>
        {openSessions.length === 0 ? (
          <Empty text="No one is currently clocked in." icon="event_busy" />
        ) : (
          <ul className="grid gap-3">
            {openSessions.map((s) => (
              <li
                key={s.id}
                className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden />
                <span className="font-medium">{nameById.get(s.teacher_id) ?? "Unknown teacher"}</span>
                {" · "}
                {s.school?.name ?? "—"}
                {" · "}
                {s.event?.summary ?? "Class"}
                {" · since "}
                {new Date(s.clock_in_at).toLocaleTimeString()}
                {s.clock_in_status === "late" && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-warning-container px-2.5 py-1 text-xs font-semibold text-on-warning-container">
                    Late
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-warning" aria-hidden>timer</span>
          Late clock-ins
        </h2>
        {lateFlags.length === 0 ? (
          <Empty text="No open late flags." icon="check_circle" />
        ) : (
          <ul className="grid gap-3">
            {lateFlags.map((f) => (
              <li
                key={f.id}
                className="relative flex items-center justify-between gap-3 overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-warning" aria-hidden />
                <span>
                  {nameById.get(f.teacher_id) ?? "Unknown teacher"} · {f.school?.name ?? "—"} ·{" "}
                  {f.event?.summary ?? "Class"}
                </span>
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning-container text-on-warning-container"
                  aria-hidden
                >
                  <span className="material-symbols-outlined text-lg">call</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/flags" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
          View all flags →
        </Link>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-error" aria-hidden>flag</span>
          Stuck feedback sessions
        </h2>
        {stuckFeedback.length === 0 ? (
          <Empty text="No sessions stuck waiting on a Zoho webhook." icon="check_circle" />
        ) : (
          <ul className="grid gap-3">
            {stuckFeedback.map((f) => (
              <li
                key={f.id}
                className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-error" aria-hidden />
                {nameById.get(f.teacher_id) ?? "Unknown teacher"} · {f.school?.name ?? "—"} ·{" "}
                {f.event?.summary ?? "Class"}
                {f.session?.clock_in_at
                  ? ` · open since ${new Date(f.session.clock_in_at).toLocaleString()}`
                  : ""}
              </li>
            ))}
          </ul>
        )}
        <Link href="/flags" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
          View all flags →
        </Link>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>calendar_month</span>
          Calendar sync
        </h2>
        {syncFailures.length === 0 ? (
          <Empty text="All synced calendars are healthy." icon="event_available" />
        ) : (
          <ul className="grid gap-3">
            {syncFailures.map((s) => (
              <li
                key={s.calendar_id}
                className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-error" aria-hidden />
                <span className="font-medium">{s.calendar_id}</span>
                {s.last_error ? ` · ${s.last_error}` : ""}
                {" · last attempt "}
                {new Date(s.updated_at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-error" aria-hidden>event_busy</span>
          Missing clock-ins today
        </h2>
        {missing.length === 0 ? (
          <Empty text="Nothing missing today." icon="check_circle" />
        ) : (
          <ul className="grid gap-3">
            {missing.map((r) => (
              <li
                key={`${r.event_id}-${r.teacher_id}`}
                className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-error" aria-hidden />
                {nameById.get(r.teacher_id) ?? "Unknown teacher"} · {r.summary ?? "Class"} ·{" "}
                {new Date(r.start_at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>schedule</span>
          Upcoming classes
        </h2>
        {upcoming.length === 0 ? (
          <Empty text="Nothing else scheduled." icon="event_available" />
        ) : (
          <ul className="grid gap-3">
            {upcoming.map((e) => (
              <li
                key={e.id}
                className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden />
                <Link href={`/schedules/${e.id}`} className="font-medium text-primary hover:underline">
                  {e.summary ?? "Untitled event"}
                </Link>
                {" · "}
                {e.school?.name ?? "—"}
                {" · "}
                {e.start_at ? new Date(e.start_at).toLocaleString() : "—"}
                {" · "}
                {e.teacher_ids.map((id) => nameById.get(id) ?? "Unknown").join(", ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(profile.role === "operations_manager" || profile.role === "cpo") && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
            <span className="material-symbols-outlined text-primary" aria-hidden>campaign</span>
            PD relay feedback (this week)
          </h2>
          <p className="text-sm text-on-surface-variant">
            Responses to the native in-app relay self-reflection form (temporary — see NEXT_STEPS.md).
          </p>
          <a
            href="/api/relay-feedback/export"
            className="mt-3 inline-flex items-center gap-1 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>download</span>
            Download CSV →
          </a>
        </section>
      )}
    </main>
  );
}

function StatCard({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: number;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl p-4 shadow-sm ${
        warn ? "bg-error-container" : "bg-surface-container"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={`text-3xl font-bold ${warn ? "text-on-error-container" : "text-on-surface"}`}>
            {value}
          </p>
          <p className={`mt-1 text-sm ${warn ? "text-on-error-container" : "text-on-surface-variant"}`}>
            {label}
          </p>
          {note && (
            <p className={`text-xs ${warn ? "text-on-error-container" : "text-on-surface-variant"}`}>
              {note}
            </p>
          )}
        </div>
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            warn ? "bg-error text-on-error" : "bg-primary-container text-on-primary-container"
          }`}
          aria-hidden
        >
          <span className="material-symbols-outlined text-xl">{warn ? "warning" : "analytics"}</span>
        </span>
      </div>
    </div>
  );
}

function Empty({ text, icon = "inbox" }: { text: string; icon?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
      <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
        {icon}
      </span>
      <p className="text-sm text-on-surface-variant">{text}</p>
    </div>
  );
}
