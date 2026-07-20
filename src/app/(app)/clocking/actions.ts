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
  const { error } = await supabase.rpc("clock_in", {
    p_event_id: eventId,
    p_lat: lat,
    p_lng: lng,
    p_accuracy_m: accuracy,
    p_client_key: clientKey,
  });
  if (error) return { error: error.message };

  // Now clocked in => an open session exists => every clock surface shows the
  // feedback form until it's submitted. Redirect home rather than straight
  // into the feedback form (user-confirmed) — the home dashboard's re-prompt
  // card and the "Clock out" nav tile make it clear feedback is owed, without
  // forcing the teacher into it the instant they clock in.
  revalidatePath("/clocking");
  revalidatePath("/feedback");
  revalidatePath("/");
  redirect("/");
}
