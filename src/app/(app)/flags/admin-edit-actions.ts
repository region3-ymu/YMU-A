"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { describeReasonGap } from "@/lib/attendance/flag-reasons";

export type AdminAttendanceState = { error?: string; success?: boolean } | undefined;

// Correct an EXISTING session (wrong on_time/late status, or wrong clock-in
// time). The form no longer re-verifies the caller's password before calling
// this (YMU 2026-08-18) — see admin-edit-attendance-form.tsx. Nothing here
// relied on it: the gate that matters is admin_edit_attendance(), which
// re-enforces role/region and stamps admin_edited_by from auth.uid()
// regardless of what the UI allows.
export async function editAttendanceAction(
  _prev: AdminAttendanceState,
  formData: FormData,
): Promise<AdminAttendanceState> {
  await requireRole(...MANAGER_ROLES);

  const sessionId = String(formData.get("session_id") ?? "");
  const status = String(formData.get("clock_in_status") ?? "") || null;
  const clockInAtRaw = String(formData.get("clock_in_at") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const reasonNotes = String(formData.get("reason_notes") ?? "").trim();
  if (!sessionId) return { error: "No session selected." };
  // Shape only. admin_edit_attendance() re-runs the same two checks via
  // flag_resolution_note(), which is what makes them true for every caller.
  const gap = describeReasonGap(reason, reasonNotes);
  if (gap) return { error: gap };

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_edit_attendance", {
    p_session_id: sessionId,
    p_clock_in_status: status,
    p_clock_in_at: clockInAtRaw ? new Date(clockInAtRaw).toISOString() : null,
    p_reason: reason,
    p_reason_notes: reasonNotes || null,
  });
  if (error) return { error: error.message };

  revalidatePath("/flags");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  return { success: true };
}

// Record a class that a teacher genuinely gave but never clocked in for at
// all (no session row exists yet — the "missed clock-in" case).
export async function createAttendanceAction(
  _prev: AdminAttendanceState,
  formData: FormData,
): Promise<AdminAttendanceState> {
  await requireRole(...MANAGER_ROLES);

  const eventId = String(formData.get("event_id") ?? "");
  const teacherId = String(formData.get("teacher_id") ?? "");
  const status = String(formData.get("clock_in_status") ?? "");
  const clockInAtRaw = String(formData.get("clock_in_at") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const reasonNotes = String(formData.get("reason_notes") ?? "").trim();
  if (!eventId || !teacherId) return { error: "Missing class or teacher." };
  if (!clockInAtRaw) return { error: "A clock-in time is required." };
  if (!status) return { error: "A status is required." };
  const gap = describeReasonGap(reason, reasonNotes);
  if (gap) return { error: gap };

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_create_attendance", {
    p_event_id: eventId,
    p_teacher_id: teacherId,
    p_clock_in_at: new Date(clockInAtRaw).toISOString(),
    p_clock_in_status: status,
    p_reason: reason,
    p_reason_notes: reasonNotes || null,
  });
  if (error) return { error: error.message };

  revalidatePath("/flags");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  return { success: true };
}
