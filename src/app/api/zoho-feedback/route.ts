import { createAdminClient } from "@/lib/supabase/admin";

// Webhook target for the Zoho feedback form's "Integrations > Webhooks"
// config (see NEXT_STEPS.md for the exact Zoho-side setup this expects).
// Not user-authenticated — Zoho calls this directly, so the shared secret in
// a custom header is the entire authorization story. Configure the same
// value as ZOHO_FEEDBACK_WEBHOOK_SECRET here and as a Custom Header on the
// Zoho webhook (header name below).
//
// UNVERIFIED against a real Zoho delivery: Zoho's own docs don't pin down a
// single fixed payload shape (it varies with the "Content Type" and "Payload
// Parameters" the operator selects when configuring the webhook in Zoho's
// UI). This handler requires Content Type = application/json and expects the
// selected Payload Parameters to use the field Link Names below (flat body,
// OR wrapped one level under "data" — both are accepted since some Zoho
// integrations wrap submission data that way and we can't test against a
// real delivery here). Confirm the actual shape once a real form + webhook
// exist and adjust extraction below if it differs.

const SECRET_HEADER = "x-zoho-feedback-secret";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pickField(body: Record<string, unknown>, name: string): unknown {
  const data = body.data;
  if (data && typeof data === "object" && name in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>)[name];
  }
  return body[name];
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request) {
  const expectedSecret = process.env.ZOHO_FEEDBACK_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return Response.json({ error: "Webhook not configured." }, { status: 500 });
  }
  const providedSecret = request.headers.get(SECRET_HEADER) ?? "";
  if (!timingSafeEqual(providedSecret, expectedSecret)) {
    return Response.json({ error: "Invalid secret." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const sessionField = process.env.ZOHO_FEEDBACK_FIELD_SESSION || "session_id";
  const ratingField = process.env.ZOHO_FEEDBACK_FIELD_RATING || "rating";
  const summaryField = process.env.ZOHO_FEEDBACK_FIELD_SUMMARY || "summary";
  const challengesField = process.env.ZOHO_FEEDBACK_FIELD_CHALLENGES || "challenges";
  const studentsField = process.env.ZOHO_FEEDBACK_FIELD_STUDENTS_PRESENT || "students_present";

  const sessionId = pickField(body, sessionField);
  if (!isUuid(sessionId)) {
    return Response.json({ error: "Missing or invalid session id." }, { status: 400 });
  }

  const ratingRaw = pickField(body, ratingField);
  const rating = Number(ratingRaw);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return Response.json({ error: "Rating must be an integer from 1 to 5." }, { status: 400 });
  }

  const summary = String(pickField(body, summaryField) ?? "").trim();
  if (!summary) {
    return Response.json({ error: "Summary is required." }, { status: 400 });
  }

  const challengesRaw = pickField(body, challengesField);
  const challenges = challengesRaw ? String(challengesRaw).trim() || null : null;

  const studentsRaw = pickField(body, studentsField);
  let studentsPresent: number | null = null;
  if (studentsRaw !== undefined && studentsRaw !== null && studentsRaw !== "") {
    const n = Number(studentsRaw);
    if (!Number.isInteger(n) || n < 0) {
      return Response.json({ error: "Students present must be a non-negative whole number." }, { status: 400 });
    }
    studentsPresent = n;
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("close_session_from_zoho", {
    p_session_id: sessionId,
    p_rating: rating,
    p_summary: summary,
    p_challenges: challenges,
    p_students_present: studentsPresent,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ ok: true });
}
