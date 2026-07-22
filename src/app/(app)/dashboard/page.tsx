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
  await requireRole(...MANAGER_ROLES);

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
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Manager Dashboard</h1>
        <p className="mt-1 text-sm opacity-70">Today at a glance.</p>
      </header>

      <SearchBox />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <h2 className="mb-2 text-lg font-semibold">Clocked in now &amp; pending feedback</h2>
        {openSessions.length === 0 ? (
          <Empty text="No one is currently clocked in." />
        ) : (
          <ul className="grid gap-2">
            {openSessions.map((s) => (
              <li key={s.id} className="rounded-xl border border-foreground/10 p-3 text-sm">
                <span className="font-medium">{s.teacher?.full_name ?? "Unknown teacher"}</span>
                {" · "}
                {s.school?.name ?? "—"}
                {" · "}
                {s.event?.summary ?? "Class"}
                {" · since "}
                {new Date(s.clock_in_at).toLocaleTimeString()}
                {s.clock_in_status === "late" && (
                  <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300">
                    Late
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Late clock-ins</h2>
        {lateFlags.length === 0 ? (
          <Empty text="No open late flags." />
        ) : (
          <ul className="grid gap-2">
            {lateFlags.map((f) => (
              <li
                key={f.id}
                className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
              >
                {f.teacher?.full_name ?? "Unknown teacher"} · {f.school?.name ?? "—"} ·{" "}
                {f.event?.summary ?? "Class"}
              </li>
            ))}
          </ul>
        )}
        <Link href="/flags" className="mt-2 inline-block text-sm underline opacity-70">
          View all flags →
        </Link>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Stuck feedback sessions</h2>
        {stuckFeedback.length === 0 ? (
          <Empty text="No sessions stuck waiting on a Zoho webhook." />
        ) : (
          <ul className="grid gap-2">
            {stuckFeedback.map((f) => (
              <li
                key={f.id}
                className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm"
              >
                {f.teacher?.full_name ?? "Unknown teacher"} · {f.school?.name ?? "—"} ·{" "}
                {f.event?.summary ?? "Class"}
                {f.session?.clock_in_at
                  ? ` · open since ${new Date(f.session.clock_in_at).toLocaleString()}`
                  : ""}
              </li>
            ))}
          </ul>
        )}
        <Link href="/flags" className="mt-2 inline-block text-sm underline opacity-70">
          View all flags →
        </Link>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Calendar sync</h2>
        {syncFailures.length === 0 ? (
          <Empty text="All synced calendars are healthy." />
        ) : (
          <ul className="grid gap-2">
            {syncFailures.map((s) => (
              <li
                key={s.calendar_id}
                className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm"
              >
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
        <h2 className="mb-2 text-lg font-semibold">Missing clock-ins today</h2>
        {missing.length === 0 ? (
          <Empty text="Nothing missing today." />
        ) : (
          <ul className="grid gap-2">
            {missing.map((r) => (
              <li
                key={`${r.event_id}-${r.teacher_id}`}
                className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm"
              >
                {nameById.get(r.teacher_id) ?? "Unknown teacher"} · {r.summary ?? "Class"} ·{" "}
                {new Date(r.start_at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Upcoming classes</h2>
        {upcoming.length === 0 ? (
          <Empty text="Nothing else scheduled." />
        ) : (
          <ul className="grid gap-2">
            {upcoming.map((e) => (
              <li key={e.id} className="rounded-xl border border-foreground/10 p-3 text-sm">
                <Link href={`/schedules/${e.id}`} className="font-medium hover:underline">
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
      className={`rounded-2xl border p-4 ${
        warn ? "border-amber-500/40 bg-amber-500/5" : "border-foreground/10"
      }`}
    >
      <p className="text-xs uppercase tracking-wide opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {note && <p className="text-xs opacity-60">{note}</p>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm opacity-60">{text}</p>;
}
