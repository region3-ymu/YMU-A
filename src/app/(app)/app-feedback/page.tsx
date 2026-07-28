import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { canViewAppFeedback, ROLE_LABELS } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format/datetime";
import ResolveAppFeedbackButton from "./resolve-button";

export const metadata: Metadata = { title: "App feedback" };

type FeedbackRow = {
  id: string;
  submitted_by_role: keyof typeof ROLE_LABELS;
  page_path: string;
  message: string;
  screenshot_path: string | null;
  device_info: { userAgent?: string; viewport?: string } | null;
  created_at: string;
  resolved_at: string | null;
  submitted_by: { full_name: string } | null;
};

// Not role-gated via ROUTE_ROLES/proxy (that mechanism is role-only) — the
// real rule, matching migration 0024's RLS, is operations_manager/cpo OR
// is_app_admin regardless of role. Authoritative check happens right here.
export default async function AppFeedbackPage() {
  const profile = await requireProfile();
  if (!canViewAppFeedback(profile.role, profile.is_app_admin)) {
    redirect("/");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("app_feedback")
    .select(
      "id, submitted_by_role, page_path, message, screenshot_path, device_info, created_at, resolved_at, submitted_by:profiles(full_name)",
    )
    .order("resolved_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false });
  const reports = (data as unknown as FeedbackRow[]) ?? [];

  // Private bucket — sign each screenshot URL server-side (1h, plenty for a
  // single page render/reload) rather than exposing the bucket publicly.
  const withUrls = await Promise.all(
    reports.map(async (r) => {
      if (!r.screenshot_path) return { ...r, screenshotUrl: null };
      const { data: signed } = await supabase.storage
        .from("app-feedback")
        .createSignedUrl(r.screenshot_path, 3600);
      return { ...r, screenshotUrl: signed?.signedUrl ?? null };
    }),
  );

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>
            bug_report
          </span>
          App feedback
        </h1>
        <p className="text-sm text-on-surface-variant">
          Problem reports submitted by users from inside the app.
        </p>
      </header>

      {withUrls.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            check_circle
          </span>
          <p className="text-sm text-on-surface-variant">No reports yet.</p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {withUrls.map((r) => (
            <li
              key={r.id}
              className={`relative overflow-hidden rounded-2xl bg-surface-container p-4 pl-5 shadow-sm ${r.resolved_at ? "opacity-60" : ""}`}
            >
              <div className={`absolute inset-y-0 left-0 w-1.5 ${r.resolved_at ? "bg-outline-variant" : "bg-error"}`} aria-hidden />
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-on-surface">
                  {r.submitted_by?.full_name ?? ROLE_LABELS[r.submitted_by_role]}
                  <span className="ml-2 rounded-full bg-surface-container-high px-2 py-0.5 text-xs font-normal text-on-surface-variant">
                    {ROLE_LABELS[r.submitted_by_role]}
                  </span>
                </span>
                <span className="text-xs text-on-surface-variant">{formatDateTime(r.created_at)}</span>
              </div>
              <p className="mt-2 text-sm text-on-surface">{r.message}</p>
              <p className="mt-1 text-xs text-on-surface-variant">
                Page: {r.page_path}
                {r.device_info?.userAgent ? ` · ${r.device_info.userAgent}` : ""}
              </p>
              {r.screenshotUrl && (
                <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block">
                  <img
                    src={r.screenshotUrl}
                    alt="Attached screenshot"
                    className="max-h-48 rounded-lg border border-outline-variant/40"
                  />
                </a>
              )}
              {!r.resolved_at && <ResolveAppFeedbackButton feedbackId={r.id} />}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
