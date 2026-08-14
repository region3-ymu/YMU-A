import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import SchedulesExplorer from "./schedules-explorer";
import { resolveScheduleRange, scheduleRangeOptions } from "@/lib/schedules/range";
import {
  SCHEDULE_LIST_COLUMNS,
  type CalendarSyncIssue,
  type ScheduleEvent,
  type ScheduleSchool,
} from "./types";

export const metadata: Metadata = { title: "Schedules" };

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const caller = await requireProfile();
  const supabase = await createClient();
  const now = new Date();
  // The window lives in the URL because it bounds the server query — the same
  // rule /reports follows. School and region stay client-side below, since
  // those only filter rows already fetched.
  const range = resolveScheduleRange((await searchParams).range, now.getTime());

  const [
    { data: events, error: eventsError },
    { data: schools, error: schoolsError },
    { data: calendarIssues, error: calendarIssuesError },
  ] = await Promise.all([
    supabase
      .from("calendar_events")
      .select(SCHEDULE_LIST_COLUMNS)
      .neq("status", "cancelled")
      // start_at, not end_at: it is the indexed column
      // (calendar_events_start_at_idx), and filtering on end_at meant a
      // sequential scan over every row in the table.
      .gte("start_at", range.from)
      .lt("start_at", range.to)
      .order("start_at"),
    supabase.from("schools").select("id, name, address, region, google_calendar_id").order("name"),
    supabase
      .from("calendar_sync_issues")
      .select("id, calendar_id, calendar_summary, reason, candidates, detected_at")
      .is("resolved_at", null)
      .order("detected_at"),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-2 p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface"><span className="material-symbols-outlined" aria-hidden>calendar_month</span>Schedules</h1>
      <p className="text-sm text-on-surface-variant">{caller.role === "teacher" ? "Your upcoming classes" : "Classes by school and region"}</p>
      {(eventsError || schoolsError || calendarIssuesError) && <p role="alert" className="mt-4 rounded-2xl bg-error-container p-4 text-sm text-on-error-container shadow-sm">Couldn&apos;t load schedules: {(eventsError ?? schoolsError ?? calendarIssuesError)?.message}</p>}
      <div className="mt-4">
        <SchedulesExplorer
          events={(events ?? []) as unknown as ScheduleEvent[]}
          schools={(schools ?? []) as ScheduleSchool[]}
          calendarIssues={(calendarIssues ?? []) as unknown as CalendarSyncIssue[]}
          callerRole={caller.role}
          now={now.toISOString()}
          range={range.key}
          rangeOptions={scheduleRangeOptions()}
        />
      </div>
    </main>
  );
}
