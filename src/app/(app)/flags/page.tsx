import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { getReportRoster } from "@/lib/reports/queries";
import type { RosterTeacher } from "@/lib/reports/types";
import ForceCloseForm from "./force-close-form";
import ResolveFlagButton from "./resolve-flag-button";

export const metadata: Metadata = { title: "Flags" };

type FlagRow = {
  id: string;
  type: "gps_out_of_fence" | "late_clock_in" | "feedback_stuck";
  session_id: string | null;
  teacher_id: string;
  details: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  school: { id: string; name: string; contact_name: string | null; contact_phone: string | null } | null;
  event: { id: string; summary: string | null; start_at: string | null } | null;
  session: { id: string; clock_in_at: string } | null;
};

// No profiles(full_name/phone) embed for the teacher — a Regional Manager's
// profiles_select RLS gates on profiles.region, which is null-by-design for
// teachers (Phase 3 derives a teacher's region from their scheduled schools
// instead), so that embed silently came back null for every teacher here —
// breaking the "call the teacher" escalation this whole page exists for.
// getReportRoster() below resolves name/phone correctly (region-scoped via
// calendar_events -> schools.region, same fix as the dashboard).
const FLAG_COLUMNS = `
  id, type, session_id, teacher_id, details, created_at, resolved_at,
  school:schools(id, name, contact_name, contact_phone),
  event:calendar_events(id, summary, start_at),
  session:attendance_sessions(id, clock_in_at)
`;

export default async function FlagsPage() {
  const caller = await requireRole(...MANAGER_ROLES);

  const supabase = await createClient();
  const [{ data }, roster] = await Promise.all([
    supabase
      .from("flags")
      .select(FLAG_COLUMNS)
      .is("resolved_at", null)
      .order("created_at", { ascending: false }),
    getReportRoster(true),
  ]);
  const flags = (data as unknown as FlagRow[]) ?? [];
  const teacherById = new Map(roster.map((t) => [t.id, t]));
  const canForceClose = caller.role === "operations_manager" || caller.role === "cpo";

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <span className="material-symbols-outlined filled text-error" aria-hidden>
            flag
          </span>
          Flags
        </h1>
        <p className="text-sm text-on-surface-variant">
          GPS, late clock-in, and stuck-feedback escalations needing manager attention.
        </p>
      </header>

      {flags.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            check_circle
          </span>
          <p className="text-sm text-on-surface-variant">No open flags.</p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {flags.map((flag) => (
            <li
              key={flag.id}
              className="relative overflow-hidden rounded-2xl bg-surface-container p-4 pl-5 shadow-sm"
            >
              <div
                className={`absolute inset-y-0 left-0 w-1.5 ${flag.type === "late_clock_in" ? "bg-error" : "bg-warning"}`}
                aria-hidden
              />
              {flag.type === "late_clock_in" ? (
                <LateClockInCard flag={flag} teacher={teacherById.get(flag.teacher_id)} />
              ) : flag.type === "feedback_stuck" ? (
                <StuckFeedbackCard flag={flag} teacher={teacherById.get(flag.teacher_id)} />
              ) : (
                <GpsOutOfFenceCard flag={flag} teacher={teacherById.get(flag.teacher_id)} />
              )}
              {flag.type === "feedback_stuck" && flag.session_id ? (
                canForceClose && <ForceCloseForm sessionId={flag.session_id} />
              ) : (
                <ResolveFlagButton flagId={flag.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function StuckFeedbackCard({ flag, teacher }: { flag: FlagRow; teacher: RosterTeacher | undefined }) {
  const clockInAt = flag.session?.clock_in_at;

  return (
    <div>
      <p className="flex items-center gap-2 font-semibold text-on-surface">
        <span className="material-symbols-outlined filled text-warning" aria-hidden>
          warning
        </span>
        Feedback stuck — Zoho webhook never arrived
      </p>
      <p className="mt-1 text-sm text-on-surface-variant">
        {teacher?.full_name ?? "A teacher"}
        {flag.school ? (
          <>
            {" "}at <span className="font-medium text-on-surface">{flag.school.name}</span>
          </>
        ) : null}{" "}
        clocked in{clockInAt ? ` at ${new Date(clockInAt).toLocaleString()}` : ""} and the class is
        still open — Zoho&rsquo;s feedback webhook hasn&rsquo;t closed it out. Confirm with the
        teacher directly before force-closing.
      </p>
    </div>
  );
}

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

function LateClockInCard({ flag, teacher }: { flag: FlagRow; teacher: RosterTeacher | undefined }) {
  const startAt = flag.details.scheduled_start_at as string | undefined;
  const summary = (flag.details.summary as string | undefined) ?? flag.event?.summary ?? "a class";

  return (
    <div>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-error-container px-3 py-1 text-xs font-bold text-on-error-container">
        <span className="material-symbols-outlined filled text-sm" aria-hidden>
          error
        </span>
        Missed clock-in
      </span>
      <p className="mt-2 text-sm text-on-surface-variant">
        {teacher?.full_name ?? "A teacher"} hasn&apos;t clocked in to <span className="font-medium text-on-surface">{summary}</span>
        {flag.school ? (
          <>
            {" "}at <span className="font-medium text-on-surface">{flag.school.name}</span>
          </>
        ) : null}
        {startAt ? (
          <>
            {" "}(scheduled {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(startAt))})
          </>
        ) : null}
        , more than 5 minutes past the scheduled start.
      </p>

      <ol className="mt-3 grid gap-2 text-sm">
        <li className="flex items-center justify-between gap-3 rounded-lg bg-surface-container-low p-3">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>
              person
            </span>
            <span>
              <span className="font-semibold text-on-surface">1. Call the teacher</span>
              {teacher?.full_name ? <span className="text-on-surface-variant"> — {teacher.full_name}</span> : null}
            </span>
          </span>
          {teacher?.phone ? (
            <a href={telHref(teacher.phone)} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98]">
              <span className="material-symbols-outlined filled text-sm" aria-hidden>
                call
              </span>
              Call {teacher.phone}
            </a>
          ) : (
            <span className="text-on-surface-variant">No phone on file</span>
          )}
        </li>
        <li className="flex items-center justify-between gap-3 rounded-lg bg-surface-container-low p-3">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>
              school
            </span>
            <span>
              <span className="font-semibold text-on-surface">2. Call the school contact</span>
              {flag.school?.contact_name ? <span className="text-on-surface-variant"> — {flag.school.contact_name}</span> : null}
            </span>
          </span>
          {flag.school?.contact_phone ? (
            <a href={telHref(flag.school.contact_phone)} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98]">
              <span className="material-symbols-outlined filled text-sm" aria-hidden>
                call
              </span>
              Call {flag.school.contact_phone}
            </a>
          ) : (
            <span className="text-on-surface-variant">No phone on file</span>
          )}
        </li>
      </ol>
    </div>
  );
}

function GpsOutOfFenceCard({ flag, teacher }: { flag: FlagRow; teacher: RosterTeacher | undefined }) {
  const distanceM = flag.details.distance_m as number | undefined;
  const radiusM = flag.details.geofence_radius_m as number | undefined;

  return (
    <div>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-container px-3 py-1 text-xs font-bold text-on-warning-container">
        <span className="material-symbols-outlined filled text-sm" aria-hidden>
          my_location
        </span>
        Out-of-fence GPS check
      </span>
      <p className="mt-2 text-sm text-on-surface-variant">
        {teacher?.full_name ?? "A teacher"} clocked in
        {flag.school ? (
          <>
            {" "}to <span className="font-medium text-on-surface">{flag.school.name}</span>
          </>
        ) : null}{" "}
        but a later GPS check placed them{" "}
        {distanceM != null ? <span className="font-medium text-on-surface">{Math.round(distanceM)} m</span> : "outside"} away
        {radiusM != null ? <> (fence: {radiusM} m)</> : null}.
      </p>
    </div>
  );
}
