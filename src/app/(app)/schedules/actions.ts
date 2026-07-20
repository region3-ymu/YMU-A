"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type ScheduleFormState = { error?: string; success?: string } | undefined;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function assignEventSchool(
  _previous: ScheduleFormState,
  formData: FormData,
): Promise<ScheduleFormState> {
  await requireRole(...MANAGER_ROLES);
  const eventId = String(formData.get("event_id") ?? "");
  const schoolId = String(formData.get("school_id") ?? "");
  if (!isUuid(eventId) || !isUuid(schoolId)) return { error: "Choose a valid school." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_event_school", {
    p_event_id: eventId,
    p_school_id: schoolId,
  });
  if (error) return { error: error.message };

  revalidatePath("/schedules");
  revalidatePath(`/schedules/${eventId}`);
  return { success: "School assigned. Future syncs will keep this assignment until the event Location changes." };
}

export async function resolveCalendarIssue(
  _previous: ScheduleFormState,
  formData: FormData,
): Promise<ScheduleFormState> {
  await requireRole(...MANAGER_ROLES);
  const calendarId = String(formData.get("calendar_id") ?? "");
  if (!calendarId) return { error: "Missing calendar." };
  const rawSchoolId = String(formData.get("school_id") ?? "");
  const schoolId = rawSchoolId && isUuid(rawSchoolId) ? rawSchoolId : null;
  if (rawSchoolId && !schoolId) return { error: "Choose a valid school." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_calendar_issue", {
    p_calendar_id: calendarId,
    p_school_id: schoolId,
  });
  if (error) return { error: error.message };

  revalidatePath("/schedules");
  return {
    success: schoolId
      ? "Calendar linked to that school. It will sync going forward and won't be re-matched automatically."
      : "Dismissed — this calendar won't be flagged again unless it's rediscovered.",
  };
}
