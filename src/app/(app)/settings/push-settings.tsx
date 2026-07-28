"use client";

import { useEffect, useState } from "react";
import {
  getCurrentSubscription,
  getPushSupportState,
  saveSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupportState,
} from "@/lib/push";

// iOS Safari (16.4+) only exposes the Push API to a PWA added to the home
// screen — there's no permission prompt at all from a normal browser tab, so
// "ios-needs-install" gets its own onboarding steps instead of a button that
// would otherwise just silently do nothing.
export default function PushSettings() {
  const [support, setSupport] = useState<PushSupportState>("unsupported");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const state = getPushSupportState();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser/display-mode detection is unavailable during SSR.
    setSupport(state);
    if (state === "ready") {
      void getCurrentSubscription().then((sub) => setSubscribed(sub !== null));
    }
  }, []);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      // subscribeToPush() calls Notification.requestPermission() as its
      // first await — must stay the first thing this click handler does, or
      // iOS Safari's user-activation gesture flag can already be gone.
      const subscription = await subscribeToPush();
      await saveSubscription(subscription);
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush();
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disable notifications.");
    } finally {
      setBusy(false);
    }
  }

  if (support === "unsupported") {
    return (
      <div className="rounded-2xl bg-surface-container p-4 text-sm text-on-surface-variant shadow-sm">
        Push notifications aren&apos;t supported in this browser. Email backups (for schedule changes, cancellations,
        and clock-out reminders) will still arrive.
      </div>
    );
  }

  if (support === "ios-needs-install") {
    return (
      <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
        <p className="font-semibold text-on-surface">Install YMU-A to your Home Screen first</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          iPhone/iPad only allow push notifications for apps added to your Home Screen — not for a page open in a
          browser tab.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-on-surface">
          <li>
            Tap the <strong>Share</strong> icon in Safari&apos;s toolbar.
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </li>
          <li>Open YMU-A from the new icon on your Home Screen (not from Safari).</li>
          <li>Come back to this Settings page and tap &ldquo;Enable notifications&rdquo;.</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
            <span className="material-symbols-outlined" aria-hidden>notifications</span>
          </span>
          <div>
            <p className="font-semibold text-on-surface">Push notifications</p>
            <p className="text-sm text-on-surface-variant">{subscribed ? "Enabled on this device." : "Not enabled on this device."}</p>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={subscribed ? handleDisable : handleEnable}
          className="shrink-0 rounded-full border-2 border-outline px-4 py-1.5 text-sm font-bold text-on-surface active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? "Working…" : subscribed ? "Disable" : "Enable notifications"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
    </div>
  );
}
