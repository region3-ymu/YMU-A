"use client";

import { useActionState, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { submitAppFeedback } from "@/app/(app)/app-feedback/actions";

// Global "report a problem" entry point — mounted once in the (app) layout,
// visible to every signed-in role. Any screenshot is uploaded straight to
// the private 'app-feedback' storage bucket from the browser (path prefixed
// with the uploader's own uid, per migration 0024's storage policy) before
// the server action ever runs; the action only receives the resulting path.
export default function AppFeedbackButton({ userId }: { userId: string }) {
  const pathname = usePathname();
  const [state, dispatch, pending] = useActionState(submitAppFeedback, undefined);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Lives in the header now, not floating over the page.
  //
  // It used to be a 48px filled circle pinned above the bottom nav, which put
  // it on top of whatever the page was showing at that corner — and on the
  // busier screens that is content, not blank space. As a quiet icon button
  // beside Sign out it is still reachable from every screen, which was the
  // whole point, and it covers nothing. The panel it opens is unchanged.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Report a problem"
        title="Report a problem"
        className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high"
      >
        <span className="material-symbols-outlined text-xl" aria-hidden>
          bug_report
        </span>
      </button>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadError(null);

    const formData = new FormData(event.currentTarget);
    const file = fileRef.current?.files?.[0];
    if (file) {
      setUploading(true);
      const supabase = createClient();
      const path = `${userId}/${Date.now()}-${file.name}`;
      const { error } = await supabase.storage.from("app-feedback").upload(path, file);
      setUploading(false);
      if (error) {
        setUploadError(`Screenshot upload failed: ${error.message}`);
        return;
      }
      formData.set("screenshot_path", path);
    }

    formData.set("page_path", pathname);
    formData.set(
      "device_info",
      JSON.stringify({
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      }),
    );

    dispatch(formData);
  }

  if (state?.success) {
    return (
      <div className="fixed inset-x-4 bottom-24 z-40 rounded-2xl bg-tertiary-container p-4 text-on-tertiary-container shadow-lg">
        <p className="flex items-center gap-2 text-sm font-bold">
          <span className="material-symbols-outlined" aria-hidden>
            check_circle
          </span>
          Thanks — your report was sent.
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-2 text-xs font-semibold underline"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-x-4 bottom-24 z-40 rounded-2xl bg-surface-container-high p-4 shadow-lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-sm font-bold text-on-surface">
          <span className="material-symbols-outlined" aria-hidden>
            bug_report
          </span>
          Report a problem
        </p>
        <label className="text-xs font-medium text-on-surface-variant">
          What&apos;s failing?
          <textarea
            name="message"
            required
            rows={3}
            placeholder="What were you trying to do, and what happened instead?"
            className="mt-1 w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          />
        </label>
        <label className="text-xs font-medium text-on-surface-variant">
          Screenshot (optional)
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="mt-1 block w-full text-xs text-on-surface-variant"
          />
        </label>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="submit"
            disabled={pending || uploading}
            className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            {uploading ? "Uploading…" : pending ? "Sending…" : "Send report"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface"
          >
            Cancel
          </button>
        </div>
        {uploadError && (
          <p role="alert" className="text-xs text-error">
            {uploadError}
          </p>
        )}
        {state?.error && (
          <p role="alert" className="text-xs text-error">
            {state.error}
          </p>
        )}
      </form>
    </div>
  );
}
