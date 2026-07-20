// Config + URL-building for the embedded Zoho feedback form. Zoho Forms
// supports prefilling a field by appending `?<FieldLinkName>=<value>` to the
// form's embed URL (confirmed via Zoho's own community docs on prefilling
// embedded forms — field "Link Name", not label, is what the query param
// must match; this is set per-field in the Zoho form builder's field
// properties). The operator must name each field's Link Name to match the
// *_FIELD env vars below when building the form in Zoho.
//
// The form itself is ONE fixed, shared URL for every submission (user
// confirmed: the same https://zfrmz.com/... link is embedded in every
// calendar event's description already) — it is not looked up per event. What
// varies per submission is what's prefilled: session id (for the webhook to
// correlate back to the right attendance_sessions row) plus school, teacher,
// date, and class name, so the teacher only has to fill in the actual
// feedback (rating/summary/challenges/students present).
//
// UNVERIFIED against the real form for the school/teacher/date/class fields
// specifically: the *_FIELD Link Names below are placeholders (rating/
// summary/challenges/students_present/session_id were already exercised via
// a simulated webhook delivery — see DECISIONS.md — but the newly-added
// prefill fields have not been). Confirm each Link Name against the real
// Zoho form once available, and adjust the matching env var if it differs.
// The date format sent (MM/DD/YYYY) is Zoho's commonly documented prefill
// format for a Date field; also unverified against this specific form.

export type FeedbackDraft = {
  rating: number | null;
  summary: string;
  challenges: string;
  studentsPresent: string;
};

export const EMPTY_DRAFT: FeedbackDraft = {
  rating: null,
  summary: "",
  challenges: "",
  studentsPresent: "",
};

export type FeedbackPrefill = {
  schoolName: string | null;
  teacherName: string | null;
  classDate: Date;
  className: string;
};

export type ZohoFeedbackConfig = {
  formUrl: string;
  sessionField: string;
  schoolField: string;
  teacherField: string;
  dateField: string;
  classField: string;
  ratingField: string;
  summaryField: string;
  challengesField: string;
  studentsPresentField: string;
};

// Server-only (reads plain, non-NEXT_PUBLIC_ env vars); called from the
// feedback/clocking server components and passed down as props. Returns null
// if the form isn't configured yet, so the UI can show a clear "not set up"
// state instead of an iframe pointed at an empty URL.
export function getZohoFeedbackConfig(): ZohoFeedbackConfig | null {
  const formUrl = process.env.ZOHO_FEEDBACK_FORM_URL;
  if (!formUrl) return null;
  return {
    formUrl,
    sessionField: process.env.ZOHO_FEEDBACK_FIELD_SESSION || "session_id",
    schoolField: process.env.ZOHO_FEEDBACK_FIELD_SCHOOL || "school",
    teacherField: process.env.ZOHO_FEEDBACK_FIELD_TEACHER || "teacher",
    dateField: process.env.ZOHO_FEEDBACK_FIELD_DATE || "date",
    classField: process.env.ZOHO_FEEDBACK_FIELD_CLASS || "class",
    ratingField: process.env.ZOHO_FEEDBACK_FIELD_RATING || "rating",
    summaryField: process.env.ZOHO_FEEDBACK_FIELD_SUMMARY || "summary",
    challengesField: process.env.ZOHO_FEEDBACK_FIELD_CHALLENGES || "challenges",
    studentsPresentField: process.env.ZOHO_FEEDBACK_FIELD_STUDENTS_PRESENT || "students_present",
  };
}

function formatDateForZoho(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}

// Builds the iframe src: always prefills the session id (so the webhook can
// correlate the submission back to the right row) plus school/teacher/date/
// class so the teacher doesn't have to retype them; also prefills any saved
// offline draft, so a teacher who answered while offline just has to review
// and hit submit inside the Zoho form once they're back online.
export function buildZohoFeedbackUrl(
  config: ZohoFeedbackConfig,
  sessionId: string,
  prefill: FeedbackPrefill,
  draft?: FeedbackDraft,
): string {
  const url = new URL(config.formUrl);
  url.searchParams.set(config.sessionField, sessionId);
  if (prefill.schoolName) url.searchParams.set(config.schoolField, prefill.schoolName);
  if (prefill.teacherName) url.searchParams.set(config.teacherField, prefill.teacherName);
  url.searchParams.set(config.dateField, formatDateForZoho(prefill.classDate));
  url.searchParams.set(config.classField, prefill.className);
  if (draft) {
    if (draft.rating != null) url.searchParams.set(config.ratingField, String(draft.rating));
    if (draft.summary) url.searchParams.set(config.summaryField, draft.summary);
    if (draft.challenges) url.searchParams.set(config.challengesField, draft.challenges);
    if (draft.studentsPresent) url.searchParams.set(config.studentsPresentField, draft.studentsPresent);
  }
  return url.toString();
}
