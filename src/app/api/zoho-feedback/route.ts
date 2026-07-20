import { createAdminClient } from "@/lib/supabase/admin";

// Webhook target for the Zoho feedback form's "Integrations > Webhooks"
// config (see NEXT_STEPS.md for the exact Zoho-side setup this expects).
// Not user-authenticated — Zoho calls this directly, so the shared secret in
// a custom header is the entire authorization story. Configure the same
// value as ZOHO_FEEDBACK_WEBHOOK_SECRET here and as a Custom Header on the
// Zoho webhook (header name below).
//
// Field Link Names read directly from the real "TeacherFeedback" form's
// rendered HTML (not guessed — see DECISIONS.md). session_id is a hidden
// field that must still be added to the real form (no such field exists yet
// as of writing this) so this handler can correlate a submission back to the
// right attendance_sessions row.
//
// UNVERIFIED against a real Zoho delivery: Zoho's own docs don't pin down a
// single fixed payload shape (it varies with the "Content Type" and "Payload
// Parameters" the operator selects when configuring the webhook in Zoho's
// UI). This handler requires Content Type = application/json and expects the
// selected Payload Parameters to use the field Link Names below (flat body,
// OR wrapped one level under "data" — both are accepted since some Zoho
// integrations wrap submission data that way and we can't test against a
// real delivery here). Confirm the actual shape once the webhook is
// configured and adjust extraction below if it differs.

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
  const engagementField = process.env.ZOHO_FEEDBACK_FIELD_ENGAGEMENT || "MultipleChoice";
  const hadIssueField = process.env.ZOHO_FEEDBACK_FIELD_HAD_ISSUE || "MultipleChoice1";
  const issueStatusField = process.env.ZOHO_FEEDBACK_FIELD_ISSUE_STATUS || "MultipleChoice2";
  const notesField = process.env.ZOHO_FEEDBACK_FIELD_NOTES || "MultiLine";

  const sessionId = pickField(body, sessionField);
  if (!isUuid(sessionId)) {
    return Response.json({ error: "Missing or invalid session id." }, { status: 400 });
  }

  const engagement = String(pickField(body, engagementField) ?? "").trim();
  if (!engagement) {
    return Response.json({ error: "Engagement is required." }, { status: 400 });
  }

  const hadIssue = String(pickField(body, hadIssueField) ?? "").trim();
  if (hadIssue !== "Yes" && hadIssue !== "No") {
    return Response.json({ error: "Had issue must be Yes or No." }, { status: 400 });
  }

  const issueStatusRaw = pickField(body, issueStatusField);
  const issueStatus = issueStatusRaw ? String(issueStatusRaw).trim() || null : null;

  const notesRaw = pickField(body, notesField);
  const notes = notesRaw ? String(notesRaw).trim() || null : null;

  const admin = createAdminClient();
  const { error } = await admin.rpc("close_session_from_zoho", {
    p_session_id: sessionId,
    p_engagement: engagement,
    p_had_issue: hadIssue,
    p_issue_status: issueStatus,
    p_notes: notes,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ ok: true });
}
