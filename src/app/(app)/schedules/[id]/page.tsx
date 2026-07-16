import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { eventTitle, formatEventTime } from "../format";
import type { ScheduleAttendee, ScheduleEvent } from "../types";

export const metadata: Metadata = { title: "Schedule event" };

export default async function ScheduleEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("calendar_events")
    .select("id, summary, description, location_raw, start_at, end_at, all_day, status, html_link, organizer_email, attendees, teacher_ids, school_id, school_match_score, school_match_source, raw, school:schools(id, name, address, region)")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) notFound();
  const event = data as unknown as ScheduleEvent;
  const videoLink = readString(event.raw?.hangoutLink) ?? conferenceLink(event.raw?.conferenceData);

  return (
    <main className="flex flex-1 flex-col gap-5 p-6">
      <Link href="/schedules" className="text-sm underline opacity-70">← Schedules</Link>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{eventTitle(event)}</h1>
          {event.status === "cancelled" && <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold text-white">Cancelled</span>}
        </div>
        <p className="mt-1 text-sm opacity-70">{formatEventTime(event)}</p>
      </header>

      <div className="grid max-w-2xl gap-4">
        <Detail label="Location">
          <p className="font-medium">{event.school?.name ?? event.location_raw ?? "No location"}</p>
          {event.location_raw && event.school && <p className="text-sm opacity-70">{event.location_raw}</p>}
          {event.school?.address && <p className="text-sm opacity-70">{event.school.address}</p>}
        </Detail>
        {videoLink && <Detail label="Video call"><a className="text-accent underline" href={videoLink} target="_blank" rel="noreferrer">Join video meeting</a></Detail>}
        {event.description && <Detail label="Description"><p className="whitespace-pre-wrap text-sm leading-6">{event.description}</p></Detail>}
        <Detail label="Organizer"><p>{event.organizer_email ?? "Not supplied"}</p></Detail>
        <Detail label={`Guests (${event.attendees.length})`}><GuestList attendees={event.attendees} /></Detail>
        {event.html_link && <a className="w-fit rounded-md border border-foreground/20 px-3 py-2 text-sm font-medium hover:bg-foreground/5" href={event.html_link} target="_blank" rel="noreferrer">Open in Google Calendar</a>}
      </div>
    </main>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-foreground/10 p-4"><h2 className="text-sm font-semibold uppercase tracking-wide opacity-60">{label}</h2><div className="mt-2">{children}</div></section>;
}

function GuestList({ attendees }: { attendees: ScheduleAttendee[] }) {
  if (!attendees.length) return <p className="text-sm opacity-70">No guests listed.</p>;
  return <ul className="grid gap-2 text-sm">{attendees.map((attendee, index) => <li key={`${attendee.email ?? "guest"}-${index}`} className="flex flex-wrap justify-between gap-2"><span>{attendee.displayName || attendee.email || "Guest"}{attendee.email && attendee.displayName ? ` (${attendee.email})` : ""}{attendee.optional ? " · optional" : ""}</span><span className="capitalize opacity-65">{attendee.responseStatus?.replaceAll("_", " ") ?? "needs action"}</span></li>)}</ul>;
}

function readString(value: unknown) { return typeof value === "string" ? value : null; }

function conferenceLink(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const entryPoints = (value as { entryPoints?: unknown }).entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  const video = entryPoints.find((entry): entry is { entryPointType?: unknown; uri?: unknown } => Boolean(entry && typeof entry === "object" && (entry as { entryPointType?: unknown }).entryPointType === "video"));
  return readString(video?.uri);
}
