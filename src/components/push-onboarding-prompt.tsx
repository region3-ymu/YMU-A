"use client";

import { useEffect, useState } from "react";
import {
  getCurrentSubscription,
  getPushSupportState,
  saveSubscription,
  subscribeToPush,
  type PushSupportState,
} from "@/lib/push";

const DISMISSED_KEY = "ymu-a-push-prompt-dismissed";

// Prompts to enable push right on the home dashboard, the first thing a
// teacher sees after logging in — rather than making them find their own way
// to Settings (user-confirmed: nobody was actually doing that). Settings
// still has the same enable/disable control for later; this is just an
// earlier, more visible nudge the first time it's relevant. Hidden entirely
// once already subscribed or once dismissed ("Not now" — persisted in
// localStorage so it doesn't nag on every login).
export default function PushOnboardingPrompt() {
  const [state, setState] = useState<"hidden" | PushSupportState>("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return;
    const support = getPushSupportState();
    if (support === "unsupported") return;
    if (support === "ios-needs-install") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- display-mode/UA detection is unavailable during SSR.
      setState("ios-needs-install");
      return;
    }
    void getCurrentSubscription().then((sub) => {
      if (!sub) setState("ready");
    });
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setState("hidden");
  }

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      const subscription = await subscribeToPush();
      await saveSubscription(subscription);
      setState("hidden");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "hidden") return null;

  return (
    <div className="mb-6 flex gap-3 rounded-2xl bg-primary-container p-4 text-on-primary-container shadow-sm">
      <span className="material-symbols-outlined mt-0.5 text-2xl" aria-hidden>
        notifications
      </span>
      <div className="flex-1">
      {state === "ios-needs-install" ? (
        <>
          <p className="font-bold">Get reminders on your phone</p>
          <p className="mt-1 text-sm text-on-primary-container/80">
            Add YMU-A to your Home Screen to get push reminders (be-there-soon, clock-in, clock-out): tap the{" "}
            <strong>Share</strong> icon in Safari → <strong>Add to Home Screen</strong> → open YMU-A from the new icon.
          </p>
          <button type="button" onClick={dismiss} className="mt-3 text-sm font-semibold text-on-primary-container/70 underline">
            Not now
          </button>
        </>
      ) : (
        <>
          <p className="font-bold">Turn on notifications?</p>
          <p className="mt-1 text-sm text-on-primary-container/80">
            Get reminders before class starts, at clock-in/clock-out, and if your schedule changes.
          </p>
          {error && <p className="mt-2 text-sm text-error">{error}</p>}
          <div className="mt-3 flex items-center gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={handleEnable}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? "Working…" : "Enable notifications"}
            </button>
            <button type="button" onClick={dismiss} className="text-sm font-semibold text-on-primary-container/70 underline">
              Not now
            </button>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
