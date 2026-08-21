import {
  GoogleCalendarClient,
  GoogleCalendarError,
  calendarWriteEnabled,
  parseServiceAccount,
  type GoogleCalendarAttendee,
} from "@/lib/google/calendar";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Mirror a confirmed substitution into its Google Calendar event.
 *
 * This exists because the Google event, not this app, is what decides who can
 * clock in. calendar-sync builds calendar_events.teacher_ids by matching
 * attendee emails to logins, so a substitute who is not an attendee is a
 * substitute the clocking screen will never offer and clock_in() would refuse
 * as "not assigned to this class".
 *
 * ── Why it is off by default ─────────────────────────────────────────────
 *
 * Two things are missing and neither is code. The service account requests
 * calendar.readonly, and it needs "Make changes to events" on all ~109 school
 * calendars — which it cannot grant itself, because a service account is not an
 * owner. Every calendar's owner has to re-share.
 *
 * So the default is `manual`: the substitution is recorded, the UI says the
 * Google event still needs editing, and a person edits it — today's process,
 * with a record of it. Flip GOOGLE_CALENDAR_WRITE_ENABLED once the access
 * exists and the same flow starts writing.
 *
 * ── Why it never throws ──────────────────────────────────────────────────
 *
 * The substitution is already committed by the time this runs. A Google
 * failure must not lose it: cover that YMU arranged is true whether or not a
 * calendar agrees, and the failure belongs on the row where a manager can see
 * it and go fix the event by hand.
 */
export type CalendarWriteOutcome = {
  status: "manual" | "written" | "failed";
  error?: string;
};

export async function mirrorSubstitutionToCalendar(
  substitutionId: string,
): Promise<CalendarWriteOutcome> {
  if (!calendarWriteEnabled()) return { status: "manual" };

  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!key) {
    return { status: "failed", error: "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 is not set." };
  }

  // Service role throughout: substitutions has no write policy at all (every
  // write goes through a definer function), and reading the event's raw
  // attendee list is not something a manager's session is scoped for.
  const admin = createAdminClient();

  try {
    const { data, error } = await admin
      .from("substitutions")
      .select(
        "id, status, absent_teacher_id, substitute_teacher_id, event:calendar_events!inner(calendar_id, google_event_id, attendees)",
      )
      .eq("id", substitutionId)
      .single();
    if (error || !data) {
      return { status: "failed", error: error?.message ?? "Substitution not found." };
    }

    const row = data as unknown as {
      status: string;
      absent_teacher_id: string;
      substitute_teacher_id: string;
      event: {
        calendar_id: string | null;
        google_event_id: string | null;
        attendees: GoogleCalendarAttendee[] | null;
      };
    };
    if (row.status !== "confirmed") {
      return { status: "failed", error: "That substitution is not confirmed." };
    }
    if (!row.event.calendar_id || !row.event.google_event_id) {
      return { status: "failed", error: "That class is not linked to a Google Calendar event." };
    }

    const [absent, stand_in] = await Promise.all([
      admin.auth.admin.getUserById(row.absent_teacher_id),
      admin.auth.admin.getUserById(row.substitute_teacher_id),
    ]);
    const absentEmail = absent.data.user?.email?.trim().toLowerCase();
    const substituteEmail = stand_in.data.user?.email?.trim().toLowerCase();
    if (!absentEmail || !substituteEmail) {
      return { status: "failed", error: "One of the two teachers has no email on their login." };
    }

    // Swap one attendee, keep the rest. A co-taught class has other teachers
    // on it who are not going anywhere, and the school's own calendar owner is
    // often an attendee too — rebuilding the list from scratch would drop
    // people the substitution says nothing about.
    const existing = row.event.attendees ?? [];
    const next: GoogleCalendarAttendee[] = existing
      .filter((attendee) => attendee.email?.trim().toLowerCase() !== absentEmail)
      .filter((attendee) => attendee.email?.trim().toLowerCase() !== substituteEmail);
    next.push({ email: substituteEmail });

    const client = new GoogleCalendarClient(parseServiceAccount(key));
    // The INSTANCE id, which is what google_event_id holds — calendar-sync
    // lists with singleEvents=true, so every row is already one dated
    // occurrence. Cover is for one date; patching the series would move the
    // teacher for the whole term.
    await client.patchEventAttendees(row.event.calendar_id, row.event.google_event_id, next);

    return { status: "written" };
  } catch (cause) {
    // GoogleCalendarError's message already explains a 403 as the missing
    // "Make changes to events" grant, which is the failure that will actually
    // happen and the one a manager can do something about.
    return {
      status: "failed",
      error:
        cause instanceof GoogleCalendarError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Unknown error writing to Google Calendar.",
    };
  }
}

/** Records the outcome on the substitution row. Never throws for the same reason. */
export async function recordCalendarWrite(
  substitutionId: string,
  outcome: CalendarWriteOutcome,
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.rpc("mark_substitution_calendar_write", {
      p_substitution_id: substitutionId,
      p_status: outcome.status,
      p_error: outcome.error ?? null,
    });
  } catch (cause) {
    // Worth a log and nothing more: the substitution itself is safe, and the
    // row keeps its default of 'manual', which tells the manager to check the
    // calendar — the correct advice when we do not know what happened.
    console.error("Could not record the calendar write outcome", cause);
  }
}
