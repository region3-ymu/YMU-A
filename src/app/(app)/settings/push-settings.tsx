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
      <div className="rounded-xl border border-foreground/10 p-4 text-sm opacity-70">
        Push notifications aren&apos;t supported in this browser. Email backups (for schedule changes, cancellations,
        and clock-out reminders) will still arrive.
      </div>
    );
  }

  if (support === "ios-needs-install") {
    return (
      <div className="rounded-xl border border-foreground/10 p-4">
        <p className="font-semibold">Install YMU-A to your Home Screen first</p>
        <p className="mt-1 text-sm opacity-70">
          iPhone/iPad only allow push notifications for apps added to your Home Screen — not for a page open in a
          browser tab.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
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
    <div className="rounded-xl border border-foreground/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Push notifications</p>
          <p className="text-sm opacity-70">{subscribed ? "Enabled on this device." : "Not enabled on this device."}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={subscribed ? handleDisable : handleEnable}
          className="shrink-0 rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Working…" : subscribed ? "Disable" : "Enable notifications"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
