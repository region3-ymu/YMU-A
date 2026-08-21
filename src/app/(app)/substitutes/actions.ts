"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { SUBSTITUTE_FINDER_ROLES } from "@/lib/auth/roles";
import { isAbsenceReason } from "@/lib/attendance/absence-reasons";
import {
  mirrorSubstitutionToCalendar,
  recordCalendarWrite,
  type CalendarWriteOutcome,
} from "@/lib/substitutions/calendar-write";
import type { Candidate, ConfirmResult, FindResult } from "./types";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Who could cover the given class.
 *
 * The ranking lives in find_substitutes() (migration 0060), not here — it has to,
 * because a Regional Manager's RLS scope stops at their own region and a useful
 * search reaches past it. The function is SECURITY DEFINER and re-checks the
 * caller's role itself; requireRole below is the outer layer, not the only one.
 */
export async function findSubstitutes(eventId: string): Promise<FindResult> {
  await requireRole(...SUBSTITUTE_FINDER_ROLES);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_substitutes", { p_event_id: eventId });

  if (error) return { ok: false, error: error.message };

  return { ok: true, candidates: (data ?? []) as Candidate[] };
}

/**
 * Record that one teacher is covering another's class.
 *
 * This is the step /substitutes never had. Until now the module ranked who was
 * free, handed the manager a mailto: link, and the app never learned what
 * happened next — so "who actually taught this class" was only answerable by
 * reading prose in a flag's resolution notes.
 *
 * It does NOT edit the Google Calendar event. The service account holds
 * calendar.readonly (src/lib/google/calendar.ts) and would need write access on
 * all ~109 school calendars, which their owners have to grant. Until then the
 * row is stamped calendar_write_status = 'manual' and the manager still edits
 * the attendee by hand — the same process as today, with a record of it.
 */
export async function confirmSubstitution(
  _previous: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  await requireRole(...SUBSTITUTE_FINDER_ROLES);

  const eventId = String(formData.get("event_id") ?? "");
  const absentTeacher = String(formData.get("absent_teacher_id") ?? "");
  const substitute = String(formData.get("substitute_teacher_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const reasonNotes = String(formData.get("reason_notes") ?? "").trim();

  if (!isUuid(eventId)) return { error: "Choose a class." };
  if (!isUuid(absentTeacher)) return { error: "Choose which teacher is away." };
  if (!isUuid(substitute)) return { error: "Choose a substitute." };
  // Shape only; confirm_substitution() re-checks against
  // absence_reason_label() and also re-checks the substitute is still free.
  if (!isAbsenceReason(reason)) return { error: "Choose why the teacher is away." };
  if (reason === "other" && !reasonNotes) {
    return { error: "Choosing “Other” means writing why they are away." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("confirm_substitution", {
    p_event_id: eventId,
    p_absent_teacher: absentTeacher,
    p_substitute: substitute,
    p_reason: reason,
    p_reason_notes: reasonNotes || null,
  });
  if (error) return { error: error.message };

  // The app's record is committed. Everything below is the Google half, which
  // is allowed to fail without taking the record with it — cover YMU arranged
  // is true whether or not a calendar agrees.
  const substitutionId = (data as { id?: string } | null)?.id;
  let outcome: CalendarWriteOutcome = { status: "manual" };
  if (substitutionId) {
    outcome = await mirrorSubstitutionToCalendar(substitutionId);
    await recordCalendarWrite(substitutionId, outcome);
  }

  revalidatePath("/substitutes");
  revalidatePath("/flags");

  if (outcome.status === "written") {
    return { success: "Cover recorded, and the Google Calendar event now lists the substitute." };
  }
  if (outcome.status === "failed") {
    // Named, not swallowed. The substitute cannot clock in until the event
    // says so, so "recorded" on its own would be a misleading success.
    return {
      success: `Cover recorded, but the Google Calendar event was not updated: ${outcome.error} Change the attendee by hand — until you do, the substitute cannot clock in.`,
    };
  }
  return {
    success:
      "Cover recorded. The Google Calendar event still needs its attendee changed by hand — the app cannot write to those calendars yet.",
  };
}

export async function cancelSubstitution(
  _previous: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  await requireRole(...SUBSTITUTE_FINDER_ROLES);

  const substitutionId = String(formData.get("substitution_id") ?? "");
  const reason = String(formData.get("cancel_reason") ?? "").trim();
  if (!isUuid(substitutionId)) return { error: "No substitution selected." };
  if (!reason) return { error: "A reason is required to cancel cover." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_substitution", {
    p_substitution_id: substitutionId,
    p_reason: reason,
  });
  if (error) return { error: error.message };

  revalidatePath("/substitutes");
  revalidatePath("/flags");
  // Never deleted: that cover was arranged and then withdrawn is the thing
  // worth knowing later.
  return { success: "Cover cancelled. The record stays, marked cancelled." };
}
