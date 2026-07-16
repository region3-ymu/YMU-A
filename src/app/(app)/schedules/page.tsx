import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import SchedulesExplorer from "./schedules-explorer";
import type { ScheduleEvent, ScheduleSchool } from "./types";

export const metadata: Metadata = { title: "Schedules" };

export default async function SchedulesPage() {
  const caller = await requireProfile();
  const supabase = await createClient();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [{ data: events, error: eventsError }, { data: schools, error: schoolsError }] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("id, summary, description, location_raw, start_at, end_at, all_day, status, html_link, organizer_email, attendees, teacher_ids, school_id, school_match_score, school_match_source, raw, school:schools(id, name, address, region)")
      .neq("status", "cancelled")
      .gte("end_at", todayStart.toISOString())
      .order("start_at"),
    supabase.from("schools").select("id, name, address, region").order("name"),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-2 p-6">
      <h1 className="text-2xl font-bold tracking-tight">Schedules</h1>
      <p className="text-sm opacity-70">{caller.role === "teacher" ? "Your upcoming classes" : "Classes by school and region"}</p>
      {(eventsError || schoolsError) && <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">Couldn&apos;t load schedules: {(eventsError ?? schoolsError)?.message}</p>}
      <div className="mt-4">
        <SchedulesExplorer
          events={(events ?? []) as unknown as ScheduleEvent[]}
          schools={(schools ?? []) as ScheduleSchool[]}
          callerRole={caller.role}
          now={now.toISOString()}
        />
      </div>
    </main>
  );
}
