"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import type { CalendarSyncSummary } from "./types";

export type CalendarSyncActionState =
  | { error: string; summary?: undefined }
  | { error?: undefined; summary: CalendarSyncSummary }
  | undefined;

export async function getSyncableSchools(): Promise<{ id: string; name: string }[]> {
  await requireRole(...MANAGER_ROLES);
  const supabase = await createClient();
  const { data } = await supabase
    .from("schools")
    .select("id, name")
    .not("google_calendar_id", "is", null)
    .order("name");
  return data ?? [];
}

// Manual trigger for the same calendar-sync Edge Function pg_cron calls every
// 5 minutes — for "I just added an event and don't want to wait" or "a school
// isn't syncing, let me retry just that one" without needing terminal/SQL
// access. Any manager can run it (read-only-ish: it only ever writes
// calendar_events/schools.google_calendar_id/calendar_sync_issues, nothing a
// manager couldn't already see/cause via the review queue).
export async function triggerCalendarSync(
  _prev: CalendarSyncActionState,
  formData: FormData,
): Promise<CalendarSyncActionState> {
  await requireRole(...MANAGER_ROLES);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.CALENDAR_SYNC_SECRET;
  if (!url || !secret) {
    return {
      error:
        "Calendar sync isn't configured for manual triggering yet (missing CALENDAR_SYNC_SECRET on Vercel). Ask an admin to add it.",
    };
  }

  const schoolIds = formData.getAll("school_id").map(String).filter(Boolean);

  let response: Response;
  try {
    response = await fetch(`${url}/functions/v1/calendar-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-calendar-sync-secret": secret,
      },
      body: JSON.stringify(schoolIds.length > 0 ? { schoolIds } : {}),
      // Sync can take a couple of minutes for many calendars — don't let
      // Vercel's own function timeout be the thing that cuts this short
      // silently; let the fetch itself resolve or the platform time it out.
      cache: "no-store",
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't reach the sync function." };
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) {
    return { error: body?.error ?? `Sync failed (HTTP ${response.status}).` };
  }

  revalidatePath("/schedules");
  revalidatePath("/lists/calendar-sync");
  return { summary: body as CalendarSyncSummary };
}
