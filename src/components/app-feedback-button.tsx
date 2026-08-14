"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

  // Escape closes it, like any other dialog.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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

  // The trigger stays mounted whether or not the panel is open. It used to be
  // swapped out for the panel, so a panel that failed to appear read as "the
  // button vanished" — which is exactly what happened when it moved into the
  // header (see the overlay comment below).
  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Report a problem"
      aria-expanded={open}
      title="Report a problem"
      className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high"
    >
      <span className="material-symbols-outlined text-xl" aria-hidden>
        bug_report
      </span>
    </button>
  );

  // PORTALLED TO document.body ON PURPOSE, and this is load-bearing.
  //
  // The trigger lives in the (app) header, which is `backdrop-blur-xl`. A
  // non-none backdrop-filter makes an element the containing block for its
  // `position: fixed` descendants — the same rule `filter` and `transform`
  // follow. So `bottom-24` stopped meaning "96px above the viewport bottom"
  // and started meaning "96px above the header's bottom edge", i.e. y = -32px:
  // the panel rendered entirely above the top of the screen. It was opening
  // correctly and had been off-screen ever since it moved into the header.
  //
  // A portal takes the overlay out of the header's subtree entirely, so no
  // future ancestor style can capture it again. z-index has to clear
  // BottomNav's z-50 as well.
  const overlay = state?.success ? (
    <div className="fixed inset-x-4 bottom-24 z-[60] rounded-2xl bg-tertiary-container p-4 text-on-tertiary-container shadow-lg">
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
  ) : (
    <>
      <div
        className="fixed inset-0 z-[55] bg-black/50"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Report a problem"
        className="fixed inset-x-4 bottom-24 z-[60] mx-auto max-w-lg rounded-2xl bg-surface-container-high p-4 shadow-lg"
      >
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
    </>
  );

  return (
    <>
      {trigger}
      {/* `open` is false on the server and through hydration — it can only
          become true from a click — so the portal never runs without a
          document, and no mounted-guard state is needed. */}
      {open && typeof document !== "undefined" && createPortal(overlay, document.body)}
    </>
  );
}
