import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { eventTitle, formatEventTime } from "../format";
import { SCHEDULE_DETAIL_COLUMNS, type ScheduleAttendee, type ScheduleEventDetail } from "../types";

export const metadata: Metadata = { title: "Schedule event" };

export default async function ScheduleEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("calendar_events")
    .select(SCHEDULE_DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) notFound();
  const event = data as unknown as ScheduleEventDetail;
  const videoLink = readString(event.raw?.hangoutLink) ?? conferenceLink(event.raw?.conferenceData);

  return (
    <main className="flex flex-1 flex-col gap-5 p-6">
      <Link href="/schedules" className="flex w-fit items-center gap-1 text-sm font-medium text-on-surface-variant"><span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>Schedules</Link>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">{eventTitle(event)}</h1>
          {event.status === "cancelled" && <span className="inline-flex items-center gap-1 rounded-full bg-error-container px-2.5 py-1 text-xs font-semibold text-on-error-container">Cancelled</span>}
        </div>
        <p className="mt-1 flex items-center gap-1 text-sm text-on-surface-variant"><span className="material-symbols-outlined text-base" aria-hidden>schedule</span>{formatEventTime(event)}</p>
      </header>

      <div className="grid max-w-2xl gap-4">
        <Detail label="Location">
          <p className="font-medium text-on-surface">{event.school?.name ?? event.location_raw ?? "No location"}</p>
          {event.location_raw && event.school && <p className="text-sm text-on-surface-variant">{event.location_raw}</p>}
          {event.school?.address && <p className="text-sm text-on-surface-variant">{event.school.address}</p>}
        </Detail>
        {videoLink && <Detail label="Video call"><a className="inline-flex items-center gap-1 font-medium text-primary" href={videoLink} target="_blank" rel="noreferrer"><span className="material-symbols-outlined text-base" aria-hidden>videocam</span>Join video meeting</a></Detail>}
        {event.description && <Detail label="Description"><p className="whitespace-pre-wrap text-sm leading-6 text-on-surface">{event.description}</p></Detail>}
        <Detail label="Organizer"><p className="text-on-surface">{event.organizer_email ?? "Not supplied"}</p></Detail>
        <Detail label={`Guests (${event.attendees.length})`}><GuestList attendees={event.attendees} /></Detail>
        {event.html_link && <a className="flex w-fit items-center gap-2 rounded-full border-2 border-outline px-5 py-2.5 text-sm font-bold text-on-surface" href={event.html_link} target="_blank" rel="noreferrer"><span className="material-symbols-outlined text-base" aria-hidden>calendar_month</span>Open in Google Calendar</a>}
      </div>
    </main>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="rounded-2xl bg-surface-container p-4 shadow-sm"><h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">{label}</h2><div className="mt-2">{children}</div></section>;
}

function GuestList({ attendees }: { attendees: ScheduleAttendee[] }) {
  if (!attendees.length) return <p className="text-sm text-on-surface-variant">No guests listed.</p>;
  return <ul className="grid gap-2 text-sm">{attendees.map((attendee, index) => <li key={`${attendee.email ?? "guest"}-${index}`} className="flex flex-wrap justify-between gap-2"><span className="text-on-surface">{attendee.displayName || attendee.email || "Guest"}{attendee.email && attendee.displayName ? ` (${attendee.email})` : ""}{attendee.optional ? " · optional" : ""}</span><span className="capitalize text-on-surface-variant">{attendee.responseStatus?.replaceAll("_", " ") ?? "needs action"}</span></li>)}</ul>;
}

function readString(value: unknown) { return typeof value === "string" ? value : null; }

function conferenceLink(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const entryPoints = (value as { entryPoints?: unknown }).entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  const video = entryPoints.find((entry): entry is { entryPointType?: unknown; uri?: unknown } => Boolean(entry && typeof entry === "object" && (entry as { entryPointType?: unknown }).entryPointType === "video"));
  return readString(video?.uri);
}
