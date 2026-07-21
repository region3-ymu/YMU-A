import { createClient } from "@/lib/supabase/server";

// Drains the client's offline queue. Runs as the teacher (their cookie
// session), so every item is applied through the same SECURITY DEFINER RPCs as
// the online path — RLS/authz are identical, and the server re-validates the
// geofence + clamps the timestamp inside those RPCs (the client's coordinates
// are an input, never the verdict). Each item is keyed by a client-generated
// client_key that the RPCs are idempotent on, so replaying the same queue
// (even forcibly, twice) applies each record exactly once.
//
// Body:   { items: [{ client_key, kind, payload }] }
// Result: { results: [{ client_key, status: 'accepted' | 'rejected', error? }] }
//
// A per-item 'rejected' (bad payload, or the server refused re-validation) is
// reported individually and never fails the whole batch; the client keeps
// rejected items for display instead of silently dropping them.

type IncomingItem = {
  client_key: string;
  kind: "clock_in" | "gps_check";
  payload: Record<string, unknown>;
};

type ItemResult = { client_key: string; status: "accepted" | "rejected"; error?: string };

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: { items?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.items)) {
    return Response.json({ error: "Expected an items array." }, { status: 400 });
  }

  // clock_in items first, so a GPS sample whose session is clocked in within
  // this same batch resolves against the freshly-created session/checks.
  const items = (body.items as IncomingItem[])
    .filter((i) => i && isUuid(i.client_key))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "clock_in" ? -1 : 1));

  const results: ItemResult[] = [];

  for (const item of items) {
    const payload = item.payload ?? {};
    try {
      if (item.kind === "clock_in") {
        const eventId = payload.event_id;
        const lat = finite(payload.lat);
        const lng = finite(payload.lng);
        if (!isUuid(eventId) || lat === null || lng === null) {
          results.push({ client_key: item.client_key, status: "rejected", error: "Invalid clock-in payload." });
          continue;
        }
        const { error } = await supabase.rpc("clock_in", {
          p_event_id: eventId,
          p_lat: lat,
          p_lng: lng,
          p_accuracy_m: finite(payload.accuracy),
          p_client_key: item.client_key,
          p_origin: "offline",
          p_clock_in_at: isIsoDate(payload.clock_in_at) ? payload.clock_in_at : null,
        });
        results.push(
          error
            ? { client_key: item.client_key, status: "rejected", error: error.message }
            : { client_key: item.client_key, status: "accepted" },
        );
      } else if (item.kind === "gps_check") {
        const sessionKey = payload.session_client_key;
        const dueOffset = finite(payload.due_offset_min);
        const lat = finite(payload.lat);
        const lng = finite(payload.lng);
        if (!isUuid(sessionKey) || dueOffset === null || lat === null || lng === null) {
          results.push({ client_key: item.client_key, status: "rejected", error: "Invalid GPS-check payload." });
          continue;
        }
        const { error } = await supabase.rpc("record_gps_check_offline", {
          p_session_client_key: sessionKey,
          p_due_offset_min: Math.round(dueOffset),
          p_lat: lat,
          p_lng: lng,
          p_accuracy_m: finite(payload.accuracy),
          p_sampled_at: isIsoDate(payload.sampled_at) ? payload.sampled_at : null,
        });
        results.push(
          error
            ? { client_key: item.client_key, status: "rejected", error: error.message }
            : { client_key: item.client_key, status: "accepted" },
        );
      } else {
        results.push({ client_key: item.client_key, status: "rejected", error: "Unknown item kind." });
      }
    } catch (err) {
      results.push({
        client_key: item.client_key,
        status: "rejected",
        error: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  }

  return Response.json({ results });
}
