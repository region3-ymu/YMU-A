import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import ForceCloseForm from "./force-close-form";
import ResolveFlagButton from "./resolve-flag-button";

export const metadata: Metadata = { title: "Flags" };

type FlagRow = {
  id: string;
  type: "gps_out_of_fence" | "late_clock_in" | "feedback_stuck";
  session_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  teacher: { id: string; full_name: string; phone: string | null } | null;
  school: { id: string; name: string; contact_name: string | null; contact_phone: string | null } | null;
  event: { id: string; summary: string | null; start_at: string | null } | null;
  session: { id: string; clock_in_at: string } | null;
};

const FLAG_COLUMNS = `
  id, type, session_id, details, created_at, resolved_at,
  teacher:profiles!flags_teacher_id_fkey(id, full_name, phone),
  school:schools(id, name, contact_name, contact_phone),
  event:calendar_events(id, summary, start_at),
  session:attendance_sessions(id, clock_in_at)
`;

export default async function FlagsPage() {
  const caller = await requireRole(...MANAGER_ROLES);

  const supabase = await createClient();
  const { data } = await supabase
    .from("flags")
    .select(FLAG_COLUMNS)
    .is("resolved_at", null)
    .order("created_at", { ascending: false });
  const flags = (data as unknown as FlagRow[]) ?? [];
  const canForceClose = caller.role === "operations_manager" || caller.role === "cpo";

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Flags</h1>
        <p className="text-sm opacity-70">
          GPS, late clock-in, and stuck-feedback escalations needing manager attention.
        </p>
      </header>

      {flags.length === 0 ? (
        <p className="text-sm opacity-60">No open flags.</p>
      ) : (
        <ul className="grid gap-4">
          {flags.map((flag) => (
            <li key={flag.id} className="rounded-2xl border border-red-500/40 bg-red-500/5 p-4">
              {flag.type === "late_clock_in" ? (
                <LateClockInCard flag={flag} />
              ) : flag.type === "feedback_stuck" ? (
                <StuckFeedbackCard flag={flag} />
              ) : (
                <GpsOutOfFenceCard flag={flag} />
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

function StuckFeedbackCard({ flag }: { flag: FlagRow }) {
  const clockInAt = flag.session?.clock_in_at;

  return (
    <div>
      <p className="font-semibold">Feedback stuck — Zoho webhook never arrived</p>
      <p className="mt-1 text-sm opacity-80">
        {flag.teacher?.full_name ?? "A teacher"}
        {flag.school ? (
          <>
            {" "}at <span className="font-medium">{flag.school.name}</span>
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

function LateClockInCard({ flag }: { flag: FlagRow }) {
  const startAt = flag.details.scheduled_start_at as string | undefined;
  const summary = (flag.details.summary as string | undefined) ?? flag.event?.summary ?? "a class";

  return (
    <div>
      <p className="font-semibold">Missed clock-in</p>
      <p className="mt-1 text-sm opacity-80">
        {flag.teacher?.full_name ?? "A teacher"} hasn&apos;t clocked in to <span className="font-medium">{summary}</span>
        {flag.school ? (
          <>
            {" "}at <span className="font-medium">{flag.school.name}</span>
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
        <li className="flex items-center justify-between rounded-lg border border-foreground/10 bg-background p-3">
          <span>
            <span className="font-semibold">1. Call the teacher</span>
            {flag.teacher?.full_name ? <span className="opacity-70"> — {flag.teacher.full_name}</span> : null}
          </span>
          {flag.teacher?.phone ? (
            <a href={telHref(flag.teacher.phone)} className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-foreground">
              Call {flag.teacher.phone}
            </a>
          ) : (
            <span className="opacity-50">No phone on file</span>
          )}
        </li>
        <li className="flex items-center justify-between rounded-lg border border-foreground/10 bg-background p-3">
          <span>
            <span className="font-semibold">2. Call the school contact</span>
            {flag.school?.contact_name ? <span className="opacity-70"> — {flag.school.contact_name}</span> : null}
          </span>
          {flag.school?.contact_phone ? (
            <a href={telHref(flag.school.contact_phone)} className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-foreground">
              Call {flag.school.contact_phone}
            </a>
          ) : (
            <span className="opacity-50">No phone on file</span>
          )}
        </li>
      </ol>
    </div>
  );
}

function GpsOutOfFenceCard({ flag }: { flag: FlagRow }) {
  const distanceM = flag.details.distance_m as number | undefined;
  const radiusM = flag.details.geofence_radius_m as number | undefined;

  return (
    <div>
      <p className="font-semibold">Out-of-fence GPS check</p>
      <p className="mt-1 text-sm opacity-80">
        {flag.teacher?.full_name ?? "A teacher"} clocked in
        {flag.school ? (
          <>
            {" "}to <span className="font-medium">{flag.school.name}</span>
          </>
        ) : null}{" "}
        but a later GPS check placed them{" "}
        {distanceM != null ? <span className="font-medium">{Math.round(distanceM)} m</span> : "outside"} away
        {radiusM != null ? <> (fence: {radiusM} m)</> : null}.
      </p>
    </div>
  );
}
