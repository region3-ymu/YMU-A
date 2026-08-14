import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import SearchBox from "@/components/search-box";
import { formatDateTime, formatTime } from "@/lib/format/datetime";
import AdminEditAttendanceForm from "../flags/admin-edit-attendance-form";
import { getReportRoster } from "@/lib/reports/queries";
import { isOverdue } from "@/lib/attendance/feedback-due";
import { classifyLateFlag, describeLateFlag, needsChasing } from "@/lib/attendance/late-flags";
import {
  getCalendarSyncHealth,
  getOpenLateFlags,
  getOpenSessions,
  getNotificationHealth,
  getPendingFeedback,
  getReviewedAttendanceKeys,
  getTeachersWithoutApp,
  getTodayAttendanceRows,
  getUpcomingClasses,
} from "./queries";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const profile = await requireRole(...MANAGER_ROLES);

  const [
    openSessions,
    lateFlags,
    pendingFeedback,
    syncFailures,
    notifications,
    noAppTeachers,
    todayRows,
    reviewedKeys,
    upcoming,
    roster,
  ] = await Promise.all([
    getOpenSessions(),
    getOpenLateFlags(),
    getPendingFeedback(),
    getCalendarSyncHealth(),
    getNotificationHealth(),
    getTeachersWithoutApp(),
    getTodayAttendanceRows(),
    getReviewedAttendanceKeys(),
    getUpcomingClasses(),
    getReportRoster(true),
  ]);

  const nameById = new Map(roster.map((t) => [t.id, t.full_name]));
  const scheduledTeacherIds = new Set(todayRows.map((r) => r.teacher_id));
  // A class whose flag a manager has already resolved is not still asking for
  // attention. Without this it stayed here for good, because this list is
  // derived from "no session and the class has ended" and never looked at the
  // flag at all — resolving on /flags and coming back here changed nothing.
  const allMissed = todayRows.filter((r) => r.attendance_status === "missed");
  const missing = allMissed.filter((r) => !reviewedKeys.has(`${r.event_id}:${r.teacher_id}`));
  const reviewedCount = allMissed.length - missing.length;

  // Three states, not one: arrived-but-late, still-missing with the class
  // running, and never-showed with the class over. classifyLateFlag decides
  // which; the card no longer presents them as one undifferentiated pile.
  const lateEntries = lateFlags.map((flag) => {
    const state = classifyLateFlag(flag);
    return { flag, tag: describeLateFlag(state), chase: needsChasing(state) };
  });
  // Still-absent first: they are the ones a manager can still do something about.
  lateEntries.sort((a, b) => Number(b.chase) - Number(a.chase));
  const stillAbsentCount = lateEntries.filter((e) => e.chase).length;

  // Same predicate the clock-in gate uses, so the dashboard and the block a
  // teacher hits can never disagree about who is overdue.
  const overdueFeedback = pendingFeedback.filter((s) => isOverdue(s.feedback_due_at));
  const noAppWithClasses = noAppTeachers.filter((t) => t.has_upcoming_classes);

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
        <StatCard
          label="Late"
          value={lateEntries.length}
          note={
            lateEntries.length > 0
              ? `${stillAbsentCount} still not clocked in`
              : undefined
          }
          warn={stillAbsentCount > 0}
        />
        <StatCard label="Missing clock-ins" value={missing.length} warn={missing.length > 0} />
        <StatCard
          label="Pending feedback"
          value={pendingFeedback.length}
          note={overdueFeedback.length > 0 ? `${overdueFeedback.length} overdue` : undefined}
          warn={overdueFeedback.length > 0}
        />
        <StatCard label="Upcoming classes" value={upcoming.length} />
        <StatCard
          label="Calendar sync"
          value={syncFailures.length}
          note={syncFailures.length > 0 ? "calendars failing" : "all healthy"}
          warn={syncFailures.length > 0}
        />
        <StatCard
          label="Notification failures (24h)"
          value={notifications.realFailures}
          note={notifications.realFailures > 0 ? "sends that broke" : "all delivered"}
          warn={notifications.realFailures > 0}
        />
        {/* Split out of the failure count, because it is a different problem
            with a different fix: these teachers get no reminders at all until
            they add the app to their home screen. Not a warning — nothing is
            broken, and it will be most of the roster for a while. */}
        <StatCard
          label="No app installed"
          value={noAppTeachers.length}
          note={
            noAppTeachers.length > 0
              ? `${noAppWithClasses.length} with classes coming up`
              : "everyone reachable"
          }
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
                {formatTime(s.clock_in_at)}
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
        {lateEntries.length === 0 ? (
          <Empty text="No open late flags." icon="check_circle" />
        ) : (
          <ul className="grid gap-3">
            {lateEntries.map(({ flag: f, tag, chase }) => (
              <li
                key={f.id}
                className="relative flex items-center justify-between gap-3 overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div
                  className={`absolute inset-y-0 left-0 w-1.5 ${chase ? "bg-error" : "bg-warning"}`}
                  aria-hidden
                />
                <span>
                  {nameById.get(f.teacher_id) ?? "Unknown teacher"} · {f.school?.name ?? "—"} ·{" "}
                  {f.event?.summary ?? "Class"}
                  <span
                    className={`ml-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      chase
                        ? "bg-error-container text-on-error-container"
                        : "bg-warning-container text-on-warning-container"
                    }`}
                  >
                    {tag}
                  </span>
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
          <span className="material-symbols-outlined text-primary" aria-hidden>rate_review</span>
          Teachers with pending feedback
        </h2>
        {pendingFeedback.length === 0 ? (
          <Empty text="Everyone is up to date on their feedback." icon="check_circle" />
        ) : (
          <ul className="grid gap-3">
            {/* Overdue first — those teachers are blocked from clocking in
                again until they submit, so they are the ones to chase. */}
            {[...pendingFeedback]
              .sort(
                (a, b) =>
                  new Date(a.feedback_due_at).getTime() - new Date(b.feedback_due_at).getTime(),
              )
              .map((s) => {
                const overdue = isOverdue(s.feedback_due_at);
                return (
                  <li
                    key={s.id}
                    className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
                  >
                    <div
                      className={`absolute inset-y-0 left-0 w-1.5 ${overdue ? "bg-error" : "bg-primary"}`}
                      aria-hidden
                    />
                    {nameById.get(s.teacher_id) ?? "Unknown teacher"} · {s.school?.name ?? "—"} ·{" "}
                    {s.event?.summary ?? "Class"}
                    {" · due "}
                    {formatDateTime(s.feedback_due_at)}
                    {overdue && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-error-container px-2.5 py-1 text-xs font-semibold text-on-error-container">
                        Overdue
                      </span>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
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
                {formatDateTime(s.updated_at)}
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
        {/* Say so rather than letting them silently disappear — a manager who
            resolved something should be able to see that it was counted. */}
        {reviewedCount > 0 && (
          <p className="mb-3 text-sm text-on-surface-variant">
            {reviewedCount} already reviewed and resolved on{" "}
            <Link href="/flags" className="font-semibold text-primary hover:underline">
              Flags
            </Link>
            .
          </p>
        )}
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
                {formatTime(r.start_at)}
                {profile.email && (
                  <AdminEditAttendanceForm
                    callerEmail={profile.email}
                    eventId={r.event_id}
                    teacherId={r.teacher_id}
                    scheduledStartAt={r.start_at}
                  />
                )}
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
                {e.start_at ? formatDateTime(e.start_at) : "—"}
                {" · "}
                {e.teacher_ids.map((id) => nameById.get(id) ?? "Unknown").join(", ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>phonelink_off</span>
          No app installed
        </h2>
        {noAppTeachers.length === 0 ? (
          <Empty text="Every teacher can receive push reminders." icon="phonelink_ring" />
        ) : (
          <ul className="grid gap-3">
            {noAppTeachers.map((t) => (
              <li
                key={t.teacher_id}
                className="relative overflow-hidden rounded-2xl bg-surface-container p-3 pl-5 text-sm text-on-surface shadow-sm"
              >
                <div className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden />
                {t.full_name}
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-semibold text-on-surface-variant">
                  {t.has_upcoming_classes ? "Has classes coming up" : "Nothing scheduled"}
                </span>
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
