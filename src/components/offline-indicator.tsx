"use client";

import { useEffect, useState } from "react";
import { countPending, onQueueChanged } from "@/lib/offline/queue";
import { startSyncListeners, syncNow } from "@/lib/offline/sync";

// Header chip showing connectivity + how many offline actions are waiting to
// sync. Also the one place the automatic-sync listeners are wired up (online /
// visibility / Background Sync), so mounting this in the app shell is what
// makes a reconnect actually drain the queue.
//
// navigator.onLine can't be read during SSR, so the first render assumes
// online (matching the server) and the real value is synced in an effect —
// reading it at useState-init time would diverge from the server's HTML and
// trip a hydration mismatch (the same fix documented in feedback-form.tsx).
export default function OfflineIndicator() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const stopSync = startSyncListeners();

    const refreshPending = () => {
      void countPending().then(setPending);
    };
    const unsubscribe = onQueueChanged(refreshPending);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- navigator.onLine is unreadable during SSR.
    setOnline(navigator.onLine);
    refreshPending();

    const goOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      stopSync();
      unsubscribe();
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online && pending === 0) return null;

  return (
    <span className="flex items-center gap-1.5">
      {!online && (
        <span
          title="You're offline. Clock-ins are saved on this device and will sync when you reconnect."
          className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
        >
          Offline
        </span>
      )}
      {pending > 0 && (
        <span
          title={online ? "Syncing your offline actions…" : "Waiting to sync when you reconnect."}
          className="rounded-full bg-foreground/10 px-2.5 py-0.5 text-xs font-semibold"
        >
          {pending} pending{online ? " · syncing…" : ""}
        </span>
      )}
    </span>
  );
}
