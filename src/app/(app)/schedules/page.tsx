import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import SchedulesExplorer from "./schedules-explorer";
import type { CalendarSyncIssue, ScheduleEvent, ScheduleSchool } from "./types";

export const metadata: Metadata = { title: "Schedules" };

export default async function SchedulesPage() {
  const caller = await requireProfile();
  const supabase = await createClient();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [
    { data: events, error: eventsError },
    { data: schools, error: schoolsError },
    { data: calendarIssues, error: calendarIssuesError },
  ] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("id, summary, description, location_raw, start_at, end_at, all_day, status, html_link, organizer_email, attendees, teacher_ids, school_id, school_match_score, school_match_source, raw, school:schools(id, name, address, region)")
      .neq("status", "cancelled")
      .gte("end_at", todayStart.toISOString())
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
        />
      </div>
    </main>
  );
}
