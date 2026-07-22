// Config + URL-building for the embedded Zoho feedback form. Zoho Forms
// supports prefilling a field by appending `?<FieldLinkName>=<value>` to the
// form's embed URL (field "Link Name", not label). Field Link Names and
// choice values below were read directly out of the real form's rendered
// HTML (the "TeacherFeedback" form at https://forms.zohopublic.com/
// ymuclassroomyoungmusi1/form/TeacherFeedback/...), not guessed — see
// DECISIONS.md for how and why an earlier version of this file (which
// invented a rating/summary/challenges/students_present schema without ever
// seeing the real form) was wrong.
//
// The form itself is ONE fixed, shared URL for every submission (user
// confirmed: the same https://zfrmz.com/... link is embedded in every
// calendar event's description already) — it is not looked up per event.
//
// STILL UNCONFIRMED: whether Zoho actually applies these URL-param prefills
// to Dropdown/MultipleChoice (choice) fields the same way it does for plain
// text fields — Zoho's own community threads note this is unreliable for
// some field types (Lookup fields specifically). Date/School/Program are
// Dropdowns here, not Lookups, which is the better-supported case, but this
// hasn't been confirmed with a real render showing the values pre-selected.
// A hidden "session_id" field must be added to the real form (by whoever has
// Zoho Forms access) for the webhook to correlate a submission back to the
// right attendance_sessions row — there is no such field yet.

// Exact choice text from the real form — used both for the offline draft
// picker (so a saved draft's values are always one of the form's own valid
// choices) and for prefilling those choices into the live form via the same
// draft mechanism.
export const ENGAGEMENT_OPTIONS = [
  "Very engaged",
  "Somewhat engaged",
  "For some period of time engaged",
  "Not engaged",
  "No answer due to class cancellation",
] as const;

export const ISSUE_STATUS_OPTIONS = [
  "Resolved: The issue has been completely resolved and is no longer a concern.",
  "In Progress: Efforts are currently underway to address and resolve the issue.",
  "Ongoing: The issue is still present and has not been resolved yet. (Please expand in the comments section)",
  "Escalated: The issue has been escalated to higher authorities.",
] as const;

export type FeedbackDraft = {
  engagement: string | null;
  hadIssue: "Yes" | "No" | null;
  issueStatus: string | null;
  notes: string;
};

export const EMPTY_DRAFT: FeedbackDraft = {
  engagement: null,
  hadIssue: null,
  issueStatus: null,
  notes: "",
};

export type FeedbackPrefill = {
  schoolName: string | null;
  teacherName: string | null;
  // The teacher's profile id, prefilled into a hidden field so the inbound
  // webhook can confirm the session being closed actually belongs to them.
  teacherId: string | null;
  classDate: Date;
  className: string;
};

export type ZohoFeedbackConfig = {
  formUrl: string;
  sessionField: string;
  // Hidden field carrying the teacher's profile id, so the webhook can verify
  // the submission's session belongs to that teacher (see close_session_from_zoho).
  teacherIdField: string;
  schoolField: string;
  teacherField: string;
  dateField: string;
  classField: string;
  engagementField: string;
  hadIssueField: string;
  issueStatusField: string;
  notesField: string;
};

// Server-only (reads plain, non-NEXT_PUBLIC_ env vars); called from the
// feedback/clocking server components and passed down as props. Returns null
// if the form isn't configured yet, so the UI can show a clear "not set up"
// state instead of an iframe pointed at an empty URL. Defaults are the real
// Link Names read from the live form; override via env var only if the form
// is rebuilt with different ones.
export function getZohoFeedbackConfig(): ZohoFeedbackConfig | null {
  const formUrl = process.env.ZOHO_FEEDBACK_FORM_URL;
  if (!formUrl) return null;
  return {
    formUrl,
    sessionField: process.env.ZOHO_FEEDBACK_FIELD_SESSION || "session_id",
    teacherIdField: process.env.ZOHO_FEEDBACK_FIELD_TEACHER_ID || "teacher_id",
    schoolField: process.env.ZOHO_FEEDBACK_FIELD_SCHOOL || "Dropdown1",
    teacherField: process.env.ZOHO_FEEDBACK_FIELD_TEACHER || "Dropdown",
    dateField: process.env.ZOHO_FEEDBACK_FIELD_DATE || "Date",
    classField: process.env.ZOHO_FEEDBACK_FIELD_CLASS || "Dropdown2",
    engagementField: process.env.ZOHO_FEEDBACK_FIELD_ENGAGEMENT || "MultipleChoice",
    hadIssueField: process.env.ZOHO_FEEDBACK_FIELD_HAD_ISSUE || "MultipleChoice1",
    issueStatusField: process.env.ZOHO_FEEDBACK_FIELD_ISSUE_STATUS || "MultipleChoice2",
    notesField: process.env.ZOHO_FEEDBACK_FIELD_NOTES || "MultiLine",
  };
}

// The real field's own hidden `date_format` hint (dd-MMM-yyyy) is what its
// date picker displays; matching that for the prefill value, though this
// specific field's URL-prefill format is still unconfirmed against a live
// render (see file header).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDateForZoho(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  return `${dd}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

// Builds the iframe src: always prefills the session id (so the webhook can
// correlate the submission back to the right row) plus school/teacher/date/
// class so the teacher doesn't have to reselect them; also prefills any
// saved offline draft, so a teacher who answered while offline just has to
// review and hit submit inside the Zoho form once they're back online.
export function buildZohoFeedbackUrl(
  config: ZohoFeedbackConfig,
  sessionId: string,
  prefill: FeedbackPrefill,
  draft?: FeedbackDraft,
): string {
  const url = new URL(config.formUrl);
  url.searchParams.set(config.sessionField, sessionId);
  if (prefill.teacherId) url.searchParams.set(config.teacherIdField, prefill.teacherId);
  if (prefill.schoolName) url.searchParams.set(config.schoolField, prefill.schoolName);
  if (prefill.teacherName) url.searchParams.set(config.teacherField, prefill.teacherName);
  url.searchParams.set(config.dateField, formatDateForZoho(prefill.classDate));
  url.searchParams.set(config.classField, prefill.className);
  if (draft) {
    if (draft.engagement) url.searchParams.set(config.engagementField, draft.engagement);
    if (draft.hadIssue) url.searchParams.set(config.hadIssueField, draft.hadIssue);
    if (draft.issueStatus) url.searchParams.set(config.issueStatusField, draft.issueStatus);
    if (draft.notes) url.searchParams.set(config.notesField, draft.notes);
  }
  return url.toString();
}
