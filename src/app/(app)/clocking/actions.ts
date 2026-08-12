"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

export type ClockInState = { error?: string } | undefined;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function finiteNumber(value: FormDataEntryValue | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Records a clock-in after the browser has a GPS fix. The lat/lng are sent
// from the client only so the server can re-run the geofence check itself
// (clock_in() re-derives the distance from the school's stored coordinates);
// the client-side "move closer" UI is a convenience, not the gate.
export async function clockIn(
  _previous: ClockInState,
  formData: FormData,
): Promise<ClockInState> {
  await requireRole("teacher");

  const eventId = String(formData.get("event_id") ?? "");
  const lat = finiteNumber(formData.get("lat"));
  const lng = finiteNumber(formData.get("lng"));
  const accuracy = finiteNumber(formData.get("accuracy"));
  const clientKeyRaw = String(formData.get("client_key") ?? "");
  const clientKey = isUuid(clientKeyRaw) ? clientKeyRaw : null;

  if (!isUuid(eventId)) return { error: "No class selected to clock into." };
  if (lat === null || lng === null) return { error: "Your location wasn't captured. Try again." };

  const supabase = await createClient();
  // attempt_clock_in, not clock_in: it wraps the same gate in a subtransaction
  // so a *blocked* attempt still gets written to clock_in_attempts (a RAISE
  // would roll that INSERT back), and returns a friendly message instead of
  // raising. clock_in() remains the authoritative implementation.
  const { data, error } = await supabase.rpc("attempt_clock_in", {
    p_event_id: eventId,
    p_lat: lat,
    p_lng: lng,
    p_accuracy_m: accuracy,
    p_client_key: clientKey,
  });
  if (error) return { error: error.message };
  const result = data as { ok: boolean; error_message: string | null } | null;
  if (!result?.ok) return { error: result?.error_message ?? "Clock-in failed. Please try again." };

  // Feedback is now owed for this class, but not due for 24 hours — the
  // teacher is free to go teach. Redirect home; the banner there tracks the
  // deadline.
  revalidatePath("/clocking");
  revalidatePath("/feedback");
  revalidatePath("/");
  redirect("/");
}

// clockOut() was removed with the button (YMU 2026-08-12). The clock_out()
// RPC still exists in the database for a future admin correction tool; nothing
// in the app calls it, and the cron sweep plus clock_in()'s implicit close
// cover every case the button used to.
