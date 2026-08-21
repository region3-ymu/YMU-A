"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { AUTO_CLOCK_IN_ADMIN_ROLES, MANAGER_ROLES } from "@/lib/auth/roles";
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
      // Genuinely permanent since 0050/0051. It used to wear off within five
      // minutes, because every sync run rewrote resolved_at back to null.
      : "Dismissed for good — this calendar won't be flagged again.",
  };
}

// Turn back-to-back auto clock-in on or off for one run.
//
// AUTO_CLOCK_IN_ADMIN_ROLES rather than MANAGER_ROLES, matching
// set_auto_clock_in_rule()'s own guard and the auto_clock_in_rules_write
// policy — SQL is authoritative either way, this just keeps the action from
// making a round trip that was always going to be refused.
export async function setAutoClockInRule(
  _previous: ScheduleFormState,
  formData: FormData,
): Promise<ScheduleFormState> {
  await requireRole(...AUTO_CLOCK_IN_ADMIN_ROLES);

  const schoolId = String(formData.get("school_id") ?? "");
  const teacherId = String(formData.get("teacher_id") ?? "");
  const active = String(formData.get("active") ?? "") === "on";
  const note = String(formData.get("note") ?? "").trim();
  if (!isUuid(schoolId)) return { error: "Choose a valid school." };
  if (teacherId && !isUuid(teacherId)) return { error: "Choose a valid teacher." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_auto_clock_in_rule", {
    p_school_id: schoolId,
    p_teacher_id: teacherId || null,
    p_active: active,
    p_max_gap_minutes: 15,
    p_note: note || null,
  });
  if (error) return { error: error.message };

  revalidatePath("/schedules");
  return {
    success: active
      ? "Auto clock-in is on for this run. The next class records itself once the teacher clocks into the first one."
      : "Auto clock-in is off. This run goes back to a normal clock-in per class.",
  };
}
