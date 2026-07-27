import { getZohoFeedbackConfig, type ZohoFeedbackConfig } from "@/lib/attendance/zoho-feedback";

// Config + URL-building for this week's professional-development feedback,
// which uses a plain Google Form instead of the paused Zoho form (BUGS.md).
// Google Forms has no true "hidden field" concept the way Zoho does, but it
// natively supports prefilling any question via a `entry.<id>` URL param
// (Forms' own "Get pre-filled link" feature) — used here the same way
// zoho-feedback.ts uses Zoho's field Link Names, just with Google's own
// query-param naming. session_id/teacher_id must be added as two new short-
// answer questions on the real form for this to correlate back to the right
// attendance_sessions row — see NEXT_STEPS.md for the exact setup.

export type GoogleFeedbackConfig = {
  // The form's real "viewform" URL (e.g.
  // https://docs.google.com/forms/d/e/<id>/viewform) — NOT the forms.gle
  // short link, which redirects and would need an extra hop resolved before
  // query params could be appended reliably.
  formUrl: string;
  // entry.<id> query param name for the session_id question, read from a
  // "Get pre-filled link" URL after adding that question to the real form.
  sessionEntryId: string;
  // entry.<id> query param name for the teacher_id question, same mechanism.
  teacherIdEntryId: string;
};

// Server-only (reads plain, non-NEXT_PUBLIC_ env vars). Returns null if any
// required var is missing, so the UI can show a clear "not set up" state
// instead of a broken link.
export function getGoogleFeedbackConfig(): GoogleFeedbackConfig | null {
  const formUrl = process.env.GOOGLE_FEEDBACK_FORM_URL;
  const sessionEntryId = process.env.GOOGLE_FEEDBACK_FIELD_SESSION;
  const teacherIdEntryId = process.env.GOOGLE_FEEDBACK_FIELD_TEACHER_ID;
  if (!formUrl || !sessionEntryId || !teacherIdEntryId) return null;
  return { formUrl, sessionEntryId, teacherIdEntryId };
}

// Builds the prefilled form URL: `usp=pp_url` is Google's own marker for a
// pre-filled-link visit (harmless to omit, included to match exactly what
// Forms' "Get pre-filled link" generates).
export function buildGoogleFeedbackUrl(config: GoogleFeedbackConfig, sessionId: string, teacherId: string): string {
  const url = new URL(config.formUrl);
  url.searchParams.set("usp", "pp_url");
  url.searchParams.set(config.sessionEntryId, sessionId);
  url.searchParams.set(config.teacherIdEntryId, teacherId);
  return url.toString();
}

// Which provider is currently wired into /feedback and /clocking. Defaults
// to "zoho" (unchanged behavior) — set FEEDBACK_FORM_PROVIDER=google for
// this week's PD sessions. Switching back after the week is a one-line env
// var change, no code change, no migration to undo.
export type FeedbackFormProvider = "zoho" | "google";

export function getFeedbackFormProvider(): FeedbackFormProvider {
  return process.env.FEEDBACK_FORM_PROVIDER === "google" ? "google" : "zoho";
}

export type FeedbackFormConfig =
  | { provider: "zoho"; config: ZohoFeedbackConfig }
  | { provider: "google"; config: GoogleFeedbackConfig }
  | null;

// Single entry point for both /feedback and /clocking: picks the provider
// from FEEDBACK_FORM_PROVIDER and returns its config already tagged, so the
// page components don't each duplicate the provider-switch logic.
export function getFeedbackConfig(): FeedbackFormConfig {
  if (getFeedbackFormProvider() === "google") {
    const config = getGoogleFeedbackConfig();
    return config ? { provider: "google", config } : null;
  }
  const config = getZohoFeedbackConfig();
  return config ? { provider: "zoho", config } : null;
}
