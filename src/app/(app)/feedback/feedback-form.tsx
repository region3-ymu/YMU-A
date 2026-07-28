"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { STATUS_LABELS, type AttendanceStatus } from "@/lib/attendance/status";
import {
  buildZohoFeedbackUrl,
  EMPTY_DRAFT,
  ENGAGEMENT_OPTIONS,
  ISSUE_STATUS_OPTIONS,
  type FeedbackDraft,
} from "@/lib/attendance/zoho-feedback";
import { type FeedbackFormConfig } from "@/lib/attendance/relay-feedback";
import { clearFeedbackDraft, getFeedbackDraft, saveFeedbackDraft } from "@/lib/attendance/offline-feedback-db";
import RelayFeedbackForm from "./relay-feedback-form";

export type FeedbackSession = {
  id: string;
  className: string;
  schoolName: string | null;
  teacherName: string | null;
  teacherId: string;
  clockInAt: string;
  status: AttendanceStatus;
};

const POLL_INTERVAL_MS = 4000;

// The clock-out gate. Feedback is now a Zoho-hosted form embedded here; Zoho's
// webhook (not this client) is what actually closes the session server-side
// (see close_session_from_zoho in supabase/migrations/0010). There is still
// no cancel/close control: the only way off this screen is the session
// actually closing, which we detect by polling our own row (no reliable
// cross-origin "submitted" signal from inside the Zoho iframe).
export default function FeedbackForm({
  session,
  feedbackConfig,
}: {
  session: FeedbackSession;
  feedbackConfig: FeedbackFormConfig;
}) {
  const router = useRouter();
  const clockedIn = new Date(session.clockInAt);
  // navigator.onLine isn't known during SSR, so the initial render always
  // assumes online (matching what the server rendered) and syncs the real
  // value in an effect — reading it at useState-init time would make the
  // client's first render diverge from the server's and trigger a hydration
  // mismatch (confirmed live: this exact bug showed up as a "Recoverable
  // Error" in the Next.js dev overlay before this fix).
  const [online, setOnline] = useState(true);
  const [draft, setDraft] = useState<FeedbackDraft | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from navigator.onLine, unreadable during SSR.
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    let active = true;
    getFeedbackDraft(session.id).then((d) => {
      if (!active) return;
      setDraft(d);
      setDraftLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [session.id]);

  useEffect(() => {
    if (!online || closed) return;
    const supabase = createClient();
    const interval = setInterval(async () => {
      const { data } = await supabase
        .from("attendance_sessions")
        .select("clock_out_at")
        .eq("id", session.id)
        .maybeSingle();
      if (data?.clock_out_at) {
        setClosed(true);
        await clearFeedbackDraft(session.id);
        router.refresh();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [online, closed, session.id, router]);

  if (closed) {
    return (
      <section className="rounded-2xl bg-tertiary-container p-5 text-on-tertiary-container">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="material-symbols-outlined filled" aria-hidden>check_circle</span>
          Feedback received
        </h2>
        <p className="mt-1 text-sm opacity-90">You&apos;re clocked out. Thanks!</p>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden rounded-2xl bg-surface-container p-5 shadow-sm">
      <div className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden />
      <h2 className="text-lg font-semibold text-on-surface">Class feedback</h2>
      <p className="mt-1 text-sm text-on-surface-variant">
        You clocked in to <span className="font-medium text-on-surface">{session.className}</span>
        {session.schoolName ? (
          <>
            {" "}at <span className="font-medium text-on-surface">{session.schoolName}</span>
          </>
        ) : null}{" "}
        at {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(clockedIn)} ·{" "}
        <span className={`font-semibold ${session.status === "late" ? "text-error" : "text-tertiary"}`}>
          {STATUS_LABELS[session.status]}
        </span>
        . Complete this to clock out — until you do, you can&apos;t clock into your next class.
      </p>

      {!online ? (
        feedbackConfig?.provider === "zoho" ? (
          draftLoaded && <OfflineDraftForm sessionId={session.id} initialDraft={draft} onSaved={setDraft} />
        ) : (
          <p className="mt-4 rounded-lg bg-warning-container p-3 text-sm text-on-warning-container">
            This form needs an internet connection to submit. It&apos;ll be available as soon as you&apos;re back
            online.
          </p>
        )
      ) : !feedbackConfig ? (
        <p className="mt-4 rounded-lg bg-warning-container p-3 text-sm text-on-warning-container">
          The feedback form isn&apos;t configured yet. Ask a manager to finish setting it up.
        </p>
      ) : feedbackConfig.provider === "relay" ? (
        <RelayFeedbackForm sessionId={session.id} />
      ) : draftLoaded ? (
        <div className="mt-4">
          {draft && (
            <p className="mb-2 text-sm text-on-surface-variant">
              You answered these questions while offline — review and submit below.
            </p>
          )}
          <iframe
            src={buildZohoFeedbackUrl(
              feedbackConfig.config,
              session.id,
              {
                schoolName: session.schoolName,
                teacherName: session.teacherName,
                teacherId: session.teacherId,
                classDate: clockedIn,
                className: session.className,
              },
              draft ?? undefined,
            )}
            title="Class feedback form"
            className="h-[640px] w-full rounded-lg bg-surface-container-lowest shadow-sm"
          />
          <p className="mt-2 text-xs text-on-surface-variant">
            This page updates automatically once your submission is received.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function OfflineDraftForm({
  sessionId,
  initialDraft,
  onSaved,
}: {
  sessionId: string;
  initialDraft: FeedbackDraft | null;
  onSaved: (draft: FeedbackDraft) => void;
}) {
  const [draft, setDraftState] = useState<FeedbackDraft>(initialDraft ?? EMPTY_DRAFT);
  const [saved, setSaved] = useState(false);

  const save = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!draft.engagement || !draft.hadIssue) return;
      if (draft.hadIssue === "Yes" && !draft.issueStatus) return;
      await saveFeedbackDraft(sessionId, draft);
      onSaved(draft);
      setSaved(true);
    },
    [draft, sessionId, onSaved],
  );

  return (
    <form onSubmit={save} className="mt-4 grid gap-4">
      <p className="rounded-lg bg-warning-container p-3 text-sm text-on-warning-container">
        You&apos;re offline. Answer here — it&apos;s saved on this device, and you&apos;ll review and submit it
        through the feedback form once you&apos;re back online. You still can&apos;t clock into another class
        until that final submission goes through.
      </p>

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          How engaged were the students? <span className="opacity-60">(required)</span>
        </span>
        <select
          required
          value={draft.engagement ?? ""}
          onChange={(e) => setDraftState((d) => ({ ...d, engagement: e.target.value || null }))}
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="" disabled>
            Select…
          </option>
          {ENGAGEMENT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend className="text-sm font-medium">
          Did you encounter any issues during today&apos;s class? <span className="opacity-60">(required)</span>
        </legend>
        <div className="mt-2 flex gap-3" role="radiogroup">
          {(["Yes", "No"] as const).map((option) => (
            <label key={option} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="had_issue"
                value={option}
                checked={draft.hadIssue === option}
                onChange={() => setDraftState((d) => ({ ...d, hadIssue: option, issueStatus: option === "No" ? null : d.issueStatus }))}
                required
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      {draft.hadIssue === "Yes" && (
        <label className="grid gap-1 text-sm">
          <span className="font-medium">
            What is the current status of this issue? <span className="opacity-60">(required)</span>
          </span>
          <select
            required
            value={draft.issueStatus ?? ""}
            onChange={(e) => setDraftState((d) => ({ ...d, issueStatus: e.target.value || null }))}
            className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="" disabled>
              Select…
            </option>
            {ISSUE_STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          Notes or comments / instrument needs or repairs? <span className="opacity-60">(optional)</span>
        </span>
        <textarea
          rows={3}
          value={draft.notes}
          onChange={(e) => setDraftState((d) => ({ ...d, notes: e.target.value }))}
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <button
        type="submit"
        className="justify-self-start rounded-full bg-primary px-6 py-3 text-sm font-bold text-on-primary shadow-md transition-transform active:scale-[0.98]"
      >
        Save draft
      </button>
      {saved && <p className="text-sm font-medium text-tertiary">Saved on this device.</p>}
    </form>
  );
}
