"use client";

import {
  listSendable,
  markPending,
  markRejected,
  markSyncing,
  removeItem,
} from "./queue";
import type { QueueItem } from "./db";

// Drains the offline queue through POST /api/sync. The endpoint runs as the
// teacher (cookie JWT) and routes each item to the same idempotent RPCs the
// online path uses, so this is safe to run repeatedly: a client_key that was
// already applied comes back 'accepted' (the RPC returned the existing row),
// never duplicated. That's what satisfies the acceptance criterion — a
// forcibly-replayed sync applies each record exactly once.

export type SyncItemResult = {
  client_key: string;
  status: "accepted" | "rejected";
  error?: string;
};

export type SyncResponse = { results: SyncItemResult[] };

// Client-side single-flight lock: a second syncNow() while one is in flight is
// a no-op, so a burst of triggers (online event + visibility + SW message all
// firing at once) can't double-send the same items from one tab.
let inFlight: Promise<void> | null = null;

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

async function run(): Promise<void> {
  if (!isOnline()) return;

  const items = await listSendable();
  if (items.length === 0) return;

  const keys = items.map((i) => i.client_key);
  await markSyncing(keys);

  let response: Response;
  try {
    response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map((i: QueueItem) => ({
          client_key: i.client_key,
          kind: i.kind,
          payload: i.payload,
        })),
      }),
    });
  } catch {
    // Network dropped mid-sync — revert to pending so we retry next trigger.
    await Promise.all(keys.map((k) => markPending(k, "Network error during sync.")));
    return;
  }

  if (!response.ok) {
    // Auth expired, server error, etc. Keep the items; try again later.
    await Promise.all(keys.map((k) => markPending(k, `Sync failed (${response.status}).`)));
    return;
  }

  let body: SyncResponse;
  try {
    body = (await response.json()) as SyncResponse;
  } catch {
    await Promise.all(keys.map((k) => markPending(k, "Malformed sync response.")));
    return;
  }

  const seen = new Set<string>();
  for (const result of body.results ?? []) {
    seen.add(result.client_key);
    if (result.status === "accepted") {
      await removeItem(result.client_key);
    } else {
      await markRejected(result.client_key, result.error ?? "Rejected by server.");
    }
  }
  // Any item the server didn't report on stays pending for the next run.
  await Promise.all(
    keys.filter((k) => !seen.has(k)).map((k) => markPending(k, "No result returned for this item.")),
  );
}

export function syncNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// Wire up automatic sync triggers. Returns a cleanup function. Called once from
// the always-mounted SyncManager component.
export function startSyncListeners(): () => void {
  const trigger = () => {
    void syncNow();
  };

  window.addEventListener("online", trigger);
  const onVisible = () => {
    if (document.visibilityState === "visible") trigger();
  };
  document.addEventListener("visibilitychange", onVisible);

  // The service worker fires a message when a Background Sync event wakes it
  // (see src/app/sw.ts) — re-run the drain from the page context, which is
  // where the IndexedDB queue and the authenticated fetch live.
  const onMessage = (event: MessageEvent) => {
    if (event.data === "ymu-sync") trigger();
  };
  navigator.serviceWorker?.addEventListener("message", onMessage);

  // Best-effort: register a Background Sync so a reconnect while the tab is
  // backgrounded still drains the queue. Harmless where unsupported.
  void registerBackgroundSync();

  // Initial drain in case we reconnected before this mounted.
  trigger();

  return () => {
    window.removeEventListener("online", trigger);
    document.removeEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.removeEventListener("message", onMessage);
  };
}

async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    // SyncManager isn't in the DOM lib's ServiceWorkerRegistration type.
    const sync = (reg as unknown as { sync?: { register: (tag: string) => Promise<void> } })?.sync;
    await sync?.register("ymu-sync");
  } catch {
    // Background Sync unavailable (e.g. Safari/Firefox) — the online/visibility
    // triggers above still cover the common reconnect-while-open case.
  }
}
