// @ts-nocheck
// This file runs in the Deno-based Supabase Edge Runtime. It deliberately
// uses only Web APIs plus supabase-js so the calendar protocol code can stay
// shared with the Next.js app at src/lib/google/calendar.ts.

import {
  GoogleCalendarClient,
  GoogleCalendarError,
  listAllCalendars,
  parseServiceAccount,
  type GoogleCalendarListEntry,
} from "../../../src/lib/google/calendar.ts";

const SCHOOL_MATCH_THRESHOLD = 0.5;
// Separate from SCHOOL_MATCH_THRESHOLD: that constant is tuned for free-text
// event Location strings, while a calendar summary is a short, structured
// name -- placeholder until validated against the real planned calendar
// names (see classifyDiscoveredCalendar below).
const CALENDAR_MATCH_THRESHOLD = 0.5;
// If the top two candidates score within this margin of each other, treat
// the match as ambiguous rather than guessing.
const AMBIGUITY_MARGIN = 0.08;
// Soft ceiling on one syncAllCalendars run, leaving headroom under the Edge
// Function execution limit and the 5-minute cron cadence. Calendars skipped
// because of this are picked up on the next tick -- safe, since each
// calendar's sync-token bookkeeping is independent and idempotent.
const SYNC_TIME_BUDGET_MS = 4 * 60_000;
// Small pacing delay between calendars, on top of googleFetchWithRetry's
// per-request backoff.
const CALENDAR_SYNC_DELAY_MS = 200;
const LOCK_LEASE_MINUTES = 5;
const PAGE_SIZE = 1_000;

type DatabaseEvent = {
  id: string;
  calendar_id: string;
  google_event_id: string;
  summary: string | null;
  description: string | null;
  location_raw: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  status: string;
  html_link: string | null;
  organizer_email: string | null;
  attendees: Array<Record<string, unknown>>;
  teacher_ids: string[];
  school_id: string | null;
  school_match_score: number | null;
  school_match_source: "fuzzy" | "manual" | null;
  google_updated_at: string | null;
  raw: Record<string, unknown> | null;
  synced_at: string;
};

type SyncState = {
  calendar_id: string;
  sync_token: string | null;
  full_synced_at: string | null;
  last_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
};

type Teacher = { id: string; email: string };

export type SyncResult = {
  mode: "full" | "incremental";
  recoveredExpiredToken: boolean;
  processed: number;
  reconciledRemovals: number;
  queuedNotifications: number;
  syncToken: string;
};

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for calendar sync.`);
  return value;
}

function eventTime(value: { dateTime?: string; date?: string } | undefined): string | null {
  if (value?.dateTime) return new Date(value.dateTime).toISOString();
  // All-day events have date-only values. Persist a stable UTC instant for
  // ordering; the raw payload retains the original date for display.
  if (value?.date) return `${value.date}T00:00:00.000Z`;
  return null;
}

function canonicalAttendees(attendees: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(attendees)) return [];
  return attendees
    .filter((attendee): attendee is Record<string, unknown> => Boolean(attendee && typeof attendee === "object"))
    .map((attendee) => ({
      email: typeof attendee.email === "string" ? attendee.email : undefined,
      displayName: typeof attendee.displayName === "string" ? attendee.displayName : undefined,
      responseStatus:
        typeof attendee.responseStatus === "string" ? attendee.responseStatus : undefined,
      optional: attendee.optional === true,
      organizer: attendee.organizer === true,
    }));
}

function matchedTeacherIds(attendees: Array<Record<string, unknown>>, teachersByEmail: Map<string, string>) {
  return [...new Set(
    attendees
      .map((attendee) => attendee.email)
      .filter((email): email is string => typeof email === "string")
      .map((email) => teachersByEmail.get(email.trim().toLowerCase()))
      .filter((id): id is string => Boolean(id)),
  )].sort();
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function allAffectedTeachers(previous: DatabaseEvent, next: { teacher_ids: string[] }) {
  return [...new Set([...previous.teacher_ids, ...next.teacher_ids])];
}

async function loadTeachers(supabase: any): Promise<Map<string, string>> {
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, role, archived_at")
    .eq("role", "teacher")
    .is("archived_at", null);
  if (profilesError) throw new Error(`Could not load teacher profiles: ${profilesError.message}`);

  const profileIds = new Set((profiles ?? []).map((profile: { id: string }) => profile.id));
  const byEmail = new Map<string, string>();
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw new Error(`Could not load auth users: ${error.message}`);
    for (const user of data.users ?? []) {
      if (user.email && profileIds.has(user.id)) {
        byEmail.set(user.email.trim().toLowerCase(), user.id);
      }
    }
    if (!data.users || data.users.length < PAGE_SIZE) break;
    page += 1;
  }
  return byEmail;
}

async function loadExistingEvent(
  supabase: any,
  calendarId: string,
  googleEventId: string,
): Promise<DatabaseEvent | null> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("calendar_id", calendarId)
    .eq("google_event_id", googleEventId)
    .maybeSingle();
  if (error) throw new Error(`Could not load existing calendar event: ${error.message}`);
  return data as DatabaseEvent | null;
}

async function matchSchool(supabase: any, location: string | null) {
  if (!location?.trim()) return { schoolId: null, score: null, source: null };
  const { data, error } = await supabase.rpc("match_school", { location_text: location });
  if (error) throw new Error(`Could not fuzzy-match school: ${error.message}`);
  const candidate = data?.[0] as { school_id: string; score: number } | undefined;
  if (!candidate) return { schoolId: null, score: null, source: null };
  return {
    schoolId: candidate.score >= SCHOOL_MATCH_THRESHOLD ? candidate.school_id : null,
    score: candidate.score,
    source: candidate.score >= SCHOOL_MATCH_THRESHOLD ? "fuzzy" : null,
  };
}

async function queueNotifications(
  supabase: any,
  previous: DatabaseEvent,
  next: DatabaseEvent,
): Promise<number> {
  if (previous.status === "cancelled") return 0;

  const recipients = allAffectedTeachers(previous, next);
  const rows: Array<Record<string, unknown>> = [];
  const basePayload = {
    google_event_id: next.google_event_id,
    summary: next.summary,
    previous: {
      teacher_ids: previous.teacher_ids,
      start_at: previous.start_at,
      end_at: previous.end_at,
      location_raw: previous.location_raw,
    },
    current: {
      teacher_ids: next.teacher_ids,
      start_at: next.start_at,
      end_at: next.end_at,
      location_raw: next.location_raw,
    },
  };

  if (next.status === "cancelled") {
    for (const recipientId of previous.teacher_ids) {
      rows.push({
        recipient_id: recipientId,
        event_id: next.id,
        type: "event_cancelled",
        payload: basePayload,
      });
    }
  } else {
    if (previous.start_at !== next.start_at || previous.end_at !== next.end_at || previous.all_day !== next.all_day) {
      for (const recipientId of recipients) {
        rows.push({ recipient_id: recipientId, event_id: next.id, type: "time_changed", payload: basePayload });
      }
    }
    if (previous.location_raw !== next.location_raw) {
      for (const recipientId of recipients) {
        rows.push({ recipient_id: recipientId, event_id: next.id, type: "location_changed", payload: basePayload });
      }
    }
    if (!sameStringSet(previous.teacher_ids, next.teacher_ids)) {
      for (const recipientId of recipients) {
        rows.push({ recipient_id: recipientId, event_id: next.id, type: "teacher_changed", payload: basePayload });
      }
    }
  }

  if (!rows.length) return 0;
  const { error } = await supabase.from("notification_queue").insert(rows);
  if (error) throw new Error(`Could not queue schedule-change notification: ${error.message}`);
  return rows.length;
}

async function upsertGoogleEvent(
  supabase: any,
  calendarId: string,
  googleEvent: Record<string, unknown>,
  teachersByEmail: Map<string, string>,
  syncStartedAt: string,
  detectChanges: boolean,
): Promise<number> {
  const googleEventId = googleEvent.id;
  if (typeof googleEventId !== "string" || !googleEventId) return 0;

  const previous = await loadExistingEvent(supabase, calendarId, googleEventId);
  const cancelled = googleEvent.status === "cancelled";
  const location = typeof googleEvent.location === "string" ? googleEvent.location.trim() || null : null;
  const attendees = cancelled ? previous?.attendees ?? [] : canonicalAttendees(googleEvent.attendees);
  const teacherIds = cancelled
    ? previous?.teacher_ids ?? []
    : matchedTeacherIds(attendees, teachersByEmail);

  let schoolId = previous?.school_id ?? null;
  let schoolMatchScore = previous?.school_match_score ?? null;
  let schoolMatchSource = previous?.school_match_source ?? null;
  const locationChanged = previous?.location_raw !== location;
  if (!cancelled && (!previous || locationChanged || previous.school_match_source !== "manual")) {
    if (previous?.school_match_source === "manual" && !locationChanged) {
      // Preserve the manager's correction until Google supplies a materially
      // new Location value. This branch documents the intended precedence.
    } else if (!previous || locationChanged) {
      const matched = await matchSchool(supabase, location);
      schoolId = matched.schoolId;
      schoolMatchScore = matched.score;
      schoolMatchSource = matched.source;
    }
  }

  const start = googleEvent.start as { dateTime?: string; date?: string } | undefined;
  const end = googleEvent.end as { dateTime?: string; date?: string } | undefined;
  const organizer = googleEvent.organizer as { email?: string } | undefined;
  const payload = {
    calendar_id: calendarId,
    google_event_id: googleEventId,
    ical_uid: (googleEvent.iCalUID as string | undefined) ?? previous?.raw?.iCalUID ?? null,
    recurring_event_id: (googleEvent.recurringEventId as string | undefined) ?? previous?.raw?.recurringEventId ?? null,
    summary: cancelled ? previous?.summary ?? null : (googleEvent.summary as string | undefined) ?? null,
    description: cancelled ? previous?.description ?? null : (googleEvent.description as string | undefined) ?? null,
    location_raw: cancelled ? previous?.location_raw ?? null : location,
    start_at: cancelled ? previous?.start_at ?? null : eventTime(start),
    end_at: cancelled ? previous?.end_at ?? null : eventTime(end),
    all_day: cancelled ? previous?.all_day ?? false : Boolean(start?.date && !start.dateTime),
    status: typeof googleEvent.status === "string" ? googleEvent.status : "confirmed",
    html_link: cancelled ? previous?.html_link ?? null : (googleEvent.htmlLink as string | undefined) ?? null,
    organizer_email: cancelled ? previous?.organizer_email ?? null : organizer?.email ?? null,
    attendees,
    teacher_ids: teacherIds,
    school_id: schoolId,
    school_match_score: schoolMatchScore,
    school_match_source: schoolMatchSource,
    google_updated_at: (googleEvent.updated as string | undefined) ?? previous?.google_updated_at ?? null,
    // Google cancellation deltas are often just {id, status: 'cancelled'}.
    // Keep the original detail payload alongside that delta so a cancelled
    // event still has useful context in the manager view/history.
    raw: cancelled ? { ...(previous?.raw ?? {}), ...googleEvent } : googleEvent,
    synced_at: syncStartedAt,
  };

  const { data: next, error } = await supabase
    .from("calendar_events")
    .upsert(payload, { onConflict: "calendar_id,google_event_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Could not store Google Calendar event: ${error.message}`);

  if (!previous || !detectChanges) return 0;
  return queueNotifications(supabase, previous, next as DatabaseEvent);
}

async function reconcileFullSyncRemovals(
  supabase: any,
  calendarId: string,
  syncStartedAt: string,
  detectChanges: boolean,
): Promise<{ removals: number; notifications: number }> {
  let removals = 0;
  let notifications = 0;
  while (true) {
    const { data: staleEvents, error } = await supabase
      .from("calendar_events")
      .select("*")
      .eq("calendar_id", calendarId)
      .neq("status", "cancelled")
      .lt("synced_at", syncStartedAt)
      .order("id")
      .range(0, PAGE_SIZE - 1);
    if (error) throw new Error(`Could not find events removed during full sync: ${error.message}`);
    if (!staleEvents?.length) break;

    for (const event of staleEvents as DatabaseEvent[]) {
      const { data: cancelled, error: updateError } = await supabase
        .from("calendar_events")
        .update({ status: "cancelled", synced_at: syncStartedAt })
        .eq("id", event.id)
        .select("*")
        .single();
      if (updateError) throw new Error(`Could not mark removed event cancelled: ${updateError.message}`);
      removals += 1;
      if (detectChanges) notifications += await queueNotifications(supabase, event, cancelled as DatabaseEvent);
    }
  }
  return { removals, notifications };
}

async function saveSyncState(
  supabase: any,
  state: Partial<SyncState> & { calendar_id: string },
) {
  const { error } = await supabase
    .from("calendar_sync_state")
    .upsert(state, { onConflict: "calendar_id" });
  if (error) throw new Error(`Could not update calendar sync state: ${error.message}`);
}

async function syncOneCalendar(
  supabase: any,
  google: GoogleCalendarClient,
  calendarId: string,
  teachersByEmail: Map<string, string>,
  syncStartedAt: string,
  options: { recoveredExpiredToken?: boolean } = {},
): Promise<SyncResult> {
  const { data: state, error: stateError } = await supabase
    .from("calendar_sync_state")
    .select("*")
    .eq("calendar_id", calendarId)
    .maybeSingle();
  if (stateError) throw new Error(`Could not read calendar sync state: ${stateError.message}`);
  const priorState = state as SyncState | null;
  const syncToken = priorState?.sync_token ?? undefined;
  const mode = syncToken ? "incremental" : "full";
  // A truly initial import establishes the baseline without notifying every
  // teacher. A full recovery after 410 retains full_synced_at and therefore
  // still emits real changes/removals.
  const detectChanges = Boolean(priorState?.full_synced_at);

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let processed = 0;
  let queuedNotifications = 0;
  try {
    do {
      const page = await google.listEvents({ calendarId, syncToken, pageToken });
      for (const event of page.items ?? []) {
        queuedNotifications += await upsertGoogleEvent(
          supabase,
          calendarId,
          event,
          teachersByEmail,
          syncStartedAt,
          detectChanges,
        );
        processed += 1;
      }
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof GoogleCalendarError && error.status === 410 && syncToken) {
      await saveSyncState(supabase, {
        calendar_id: calendarId,
        sync_token: null,
        full_synced_at: priorState?.full_synced_at ?? null,
        last_status: "error",
        last_error: "Google sync token expired (410); starting a full resync.",
      });
      return syncOneCalendar(supabase, google, calendarId, teachersByEmail, syncStartedAt, {
        recoveredExpiredToken: true,
      });
    }
    await saveSyncState(supabase, {
      calendar_id: calendarId,
      sync_token: priorState?.sync_token ?? null,
      full_synced_at: priorState?.full_synced_at ?? null,
      last_status: "error",
      last_error: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown calendar sync error.",
    });
    throw error;
  }

  if (!nextSyncToken) {
    const error = new Error("Google Calendar returned no nextSyncToken after a complete sync.");
    await saveSyncState(supabase, {
      calendar_id: calendarId,
      sync_token: priorState?.sync_token ?? null,
      full_synced_at: priorState?.full_synced_at ?? null,
      last_status: "error",
      last_error: error.message,
    });
    throw error;
  }

  const reconciliation = mode === "full"
    ? await reconcileFullSyncRemovals(supabase, calendarId, syncStartedAt, detectChanges)
    : { removals: 0, notifications: 0 };
  queuedNotifications += reconciliation.notifications;

  await saveSyncState(supabase, {
    calendar_id: calendarId,
    sync_token: nextSyncToken,
    full_synced_at: mode === "full" ? syncStartedAt : priorState?.full_synced_at ?? syncStartedAt,
    last_synced_at: syncStartedAt,
    last_status: "ok",
    last_error: null,
  });

  return {
    mode,
    recoveredExpiredToken: Boolean(options.recoveredExpiredToken),
    processed,
    reconciledRemovals: reconciliation.removals,
    queuedNotifications,
    syncToken: nextSyncToken,
  };
}

// ---------------------------------------------------------------------------
// Multi-calendar discovery and matching (calendar <-> school, distinct from
// the event <-> school Location match above). Pin-then-skip (user-confirmed):
// a calendar already pinned to a school (schools.google_calendar_id) is never
// re-matched -- only newly discovered/unpinned calendars are classified here.
// ---------------------------------------------------------------------------

export type CalendarMatchCandidate = { school_id: string; school_name: string; score: number };

export type DiscoveredCalendarDecision =
  | { action: "already_pinned" }
  | { action: "auto_match"; schoolId: string; score: number }
  | {
      action: "flag_issue";
      reason: "no_matching_school" | "ambiguous_match" | "school_already_linked";
      candidates: CalendarMatchCandidate[];
    };

// Pure and synchronous so it's unit-testable against synthetic
// calendars/schools with no Google or Supabase involved -- also where
// CALENDAR_MATCH_THRESHOLD/AMBIGUITY_MARGIN get validated against the real
// planned calendar-summary strings before this goes live.
//
// pinnedSchoolIds guards against two distinct Google Calendars sharing the
// same (or a very similar) name -- e.g. two calendars both literally named
// "South Dade Senior High" -- both independently scoring a perfect match
// against the one real school. Without this check, whichever one is
// processed second would silently overwrite the first's link on the next
// run; this downgrades it to a flagged issue instead.
export function classifyDiscoveredCalendar(
  calendarId: string,
  pinnedCalendarIds: ReadonlySet<string>,
  candidates: CalendarMatchCandidate[],
  pinnedSchoolIds: ReadonlySet<string> = new Set(),
): DiscoveredCalendarDecision {
  if (pinnedCalendarIds.has(calendarId)) return { action: "already_pinned" };

  const [top, second] = candidates;
  if (!top || top.score < CALENDAR_MATCH_THRESHOLD) {
    return { action: "flag_issue", reason: "no_matching_school", candidates };
  }
  if (second && top.score - second.score < AMBIGUITY_MARGIN) {
    return { action: "flag_issue", reason: "ambiguous_match", candidates };
  }
  if (pinnedSchoolIds.has(top.school_id)) {
    return { action: "flag_issue", reason: "school_already_linked", candidates };
  }
  return { action: "auto_match", schoolId: top.school_id, score: top.score };
}

async function matchSchoolCalendar(
  supabase: any,
  summary: string | undefined,
): Promise<CalendarMatchCandidate[]> {
  if (!summary?.trim()) return [];
  const { data, error } = await supabase.rpc("match_school_calendar", { calendar_summary: summary });
  if (error) throw new Error(`Could not fuzzy-match calendar: ${error.message}`);
  return (data ?? []) as CalendarMatchCandidate[];
}

// Single-row lease (supabase/migrations/0007) instead of pg_advisory_lock:
// Edge Function DB connections aren't guaranteed to hold one long-lived
// session, which makes session-scoped advisory locks unreliable here. The
// atomic UPDATE ... WHERE only lets one concurrent caller acquire the row.
async function acquireSyncLock(supabase: any): Promise<boolean> {
  const now = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + LOCK_LEASE_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("calendar_sync_lock")
    .update({ locked_until: lockedUntil })
    .eq("id", true)
    .or(`locked_until.is.null,locked_until.lt.${now}`)
    .select("id");
  if (error) throw new Error(`Could not acquire calendar sync lock: ${error.message}`);
  return Boolean(data?.length);
}

async function releaseSyncLock(supabase: any) {
  const { error } = await supabase
    .from("calendar_sync_lock")
    .update({ locked_until: new Date().toISOString() })
    .eq("id", true);
  if (error) throw new Error(`Could not release calendar sync lock: ${error.message}`);
}

type SchoolRow = { id: string; google_calendar_id: string | null };

export type CalendarSyncSummary =
  | { skipped: true }
  | {
      skipped: false;
      discovered: number;
      autoMatched: number;
      issuesRaised: number;
      partial: boolean;
      synced: Array<{ calendarId: string; schoolId: string; result?: SyncResult; error?: string }>;
    };

export async function syncAllCalendars(
  supabase: any,
  env: Record<string, string | undefined>,
  // schoolIds: when set, only these schools' calendars are synced (the
  // manual "Sync calendars" button's per-school selection) — discovery and
  // auto-matching of newly-shared calendars still runs against everything,
  // since that's cheap and independent of which schools' events get pulled.
  options: { dryRun?: boolean; schoolIds?: string[] } = {},
): Promise<CalendarSyncSummary> {
  const dryRun = Boolean(options.dryRun);
  const schoolIdFilter = options.schoolIds ? new Set(options.schoolIds) : null;
  if (!dryRun && !(await acquireSyncLock(supabase))) return { skipped: true };

  try {
    const serviceAccount = parseServiceAccount(
      requireEnv(env, "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"),
    );
    const google = new GoogleCalendarClient(serviceAccount);
    const runStartedAt = Date.now();

    const calendars: GoogleCalendarListEntry[] = await listAllCalendars(google);

    const { data: schools, error: schoolsError } = await supabase
      .from("schools")
      .select("id, google_calendar_id");
    if (schoolsError) throw new Error(`Could not load schools: ${schoolsError.message}`);
    const pinnedCalendarIds = new Set(
      (schools as SchoolRow[] ?? [])
        .map((school) => school.google_calendar_id)
        .filter((id): id is string => Boolean(id)),
    );
    const pinnedSchoolIds = new Set(
      (schools as SchoolRow[] ?? [])
        .filter((school) => Boolean(school.google_calendar_id))
        .map((school) => school.id),
    );

    let autoMatched = 0;
    let issuesRaised = 0;
    for (const calendar of calendars) {
      if (pinnedCalendarIds.has(calendar.id)) continue;

      const candidates = await matchSchoolCalendar(supabase, calendar.summary);
      const decision = classifyDiscoveredCalendar(calendar.id, pinnedCalendarIds, candidates, pinnedSchoolIds);

      if (decision.action === "already_pinned") continue;

      if (decision.action === "auto_match") {
        if (!dryRun) {
          const { error } = await supabase
            .from("schools")
            .update({
              google_calendar_id: calendar.id,
              calendar_match_source: "fuzzy",
              calendar_match_score: decision.score,
              calendar_matched_at: new Date().toISOString(),
            })
            .eq("id", decision.schoolId);
          if (error) throw new Error(`Could not pin matched calendar: ${error.message}`);

          // This calendar may have been flagged as an open issue in an
          // earlier run (e.g. before its matching school existed yet).
          // Resolve it now -- otherwise it sits open forever even though
          // the calendar is successfully matched, since nothing else in
          // this loop ever revisits an already-pinned calendar_id.
          const { error: resolveError } = await supabase
            .from("calendar_sync_issues")
            .update({ resolved_at: new Date().toISOString() })
            .eq("calendar_id", calendar.id)
            .is("resolved_at", null);
          if (resolveError) {
            throw new Error(`Could not resolve stale issue for auto-matched calendar: ${resolveError.message}`);
          }
        }
        pinnedCalendarIds.add(calendar.id);
        pinnedSchoolIds.add(decision.schoolId);
        autoMatched += 1;
      } else {
        if (!dryRun) {
          const { error } = await supabase
            .from("calendar_sync_issues")
            .upsert(
              {
                calendar_id: calendar.id,
                calendar_summary: calendar.summary ?? null,
                reason: decision.reason,
                candidates: decision.candidates,
                detected_at: new Date().toISOString(),
                resolved_at: null,
                resolved_by: null,
              },
              { onConflict: "calendar_id" },
            );
          if (error) throw new Error(`Could not record calendar sync issue: ${error.message}`);
        }
        issuesRaised += 1;
      }
    }

    if (dryRun) {
      return { skipped: false, discovered: calendars.length, autoMatched, issuesRaised, partial: false, synced: [] };
    }

    const { data: syncableSchools, error: syncableError } = await supabase
      .from("schools")
      .select("id, google_calendar_id")
      .not("google_calendar_id", "is", null);
    if (syncableError) throw new Error(`Could not load schools to sync: ${syncableError.message}`);

    const teachersByEmail = await loadTeachers(supabase);
    const synced: Array<{ calendarId: string; schoolId: string; result?: SyncResult; error?: string }> = [];
    let partial = false;

    for (const school of (syncableSchools as SchoolRow[]) ?? []) {
      if (!school.google_calendar_id) continue;
      if (schoolIdFilter && !schoolIdFilter.has(school.id)) continue;
      if (Date.now() - runStartedAt > SYNC_TIME_BUDGET_MS) {
        partial = true;
        break;
      }

      const syncStartedAt = new Date().toISOString();
      try {
        const result = await syncOneCalendar(
          supabase,
          google,
          school.google_calendar_id,
          teachersByEmail,
          syncStartedAt,
        );
        synced.push({ calendarId: school.google_calendar_id, schoolId: school.id, result });
      } catch (error) {
        synced.push({
          calendarId: school.google_calendar_id,
          schoolId: school.id,
          error: error instanceof Error ? error.message : "Unknown calendar sync error.",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, CALENDAR_SYNC_DELAY_MS));
    }

    return { skipped: false, discovered: calendars.length, autoMatched, issuesRaised, partial, synced };
  } finally {
    if (!dryRun) await releaseSyncLock(supabase);
  }
}
