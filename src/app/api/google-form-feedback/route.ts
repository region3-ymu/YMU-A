import { createAdminClient } from "@/lib/supabase/admin";

// Webhook target for this week's PD Google Form, called by an Apps Script
// "On form submit" trigger bound to the form (see NEXT_STEPS.md for the
// exact setup) — NOT called by Google directly. Not user-authenticated: the
// Apps Script relay has no teacher session, so the shared secret in a custom
// header is the entire authorization story, same pattern as
// /api/zoho-feedback. Configure the same value as
// GOOGLE_FEEDBACK_WEBHOOK_SECRET here and inside the Apps Script.
//
// Unlike Zoho, Google's onFormSubmit trigger gives the script the actual
// submitted item responses directly (by question title) — there's no
// separate "Payload Parameters" mapping step to misconfigure, so the relay
// script can just POST a clean, flat JSON body: { session_id, teacher_id,
// ...every other question's title -> answer }. Everything except
// session_id/teacher_id is stored verbatim in feedback_raw — this form's
// questions aren't a fixed schema this app needs to parse.

const SECRET_HEADER = "x-google-feedback-secret";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request) {
  const expectedSecret = process.env.GOOGLE_FEEDBACK_WEBHOOK_SECRET;
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

  const sessionId = body.session_id;
  if (!isUuid(sessionId)) {
    return Response.json({ error: "Missing or invalid session_id." }, { status: 400 });
  }

  // Optional teacher-ownership signal, same defense as Zoho's p_teacher_id:
  // present once the real form's teacher_id question is wired up and
  // actually sending a value; absent/invalid => null => unchanged behavior.
  const teacherIdRaw = body.teacher_id;
  const teacherId = isUuid(teacherIdRaw) ? teacherIdRaw : null;

  const admin = createAdminClient();
  const { error } = await admin.rpc("close_session_from_google_form", {
    p_session_id: sessionId,
    p_teacher_id: teacherId,
    p_raw_answers: body,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ ok: true });
}
