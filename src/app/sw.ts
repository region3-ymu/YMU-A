import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();

// Background Sync: when the browser regains connectivity, it fires this
// even if the tab is backgrounded. The queue and the authenticated fetch to
// /api/sync both live in the page context (IndexedDB + the Supabase cookie
// session), so rather than duplicate that logic here the SW just wakes any
// open client and lets src/lib/offline/sync.ts do the drain. Registered by
// startSyncListeners() under the "ymu-sync" tag.
self.addEventListener("sync", (event) => {
  const syncEvent = event as ExtendableEvent & { tag?: string };
  if (syncEvent.tag !== "ymu-sync") return;
  syncEvent.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      for (const client of clients) client.postMessage("ymu-sync");
    })(),
  );
});

// Phase 7: Web Push. notify-dispatch sends a JSON payload
// ({title, body, url} — see supabase/functions/notify-dispatch/dispatch-logic.ts's
// notificationCopy()); this just has to show it, since encryption/delivery is
// already handled by the browser before this handler ever runs.
self.addEventListener("push", (event) => {
  let payload: { title?: string; body?: string; url?: string } = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: "YMU-A", body: event.data?.text() ?? "" };
  }
  const { title = "YMU-A", body = "", url = "/" } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

// Focuses an already-open app tab rather than always opening a new one — a
// teacher tapping a "clock out" reminder wants their existing session, not a
// fresh tab on top of it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data as { url?: string } | undefined)?.url ?? "/";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if ("navigate" in existing) await (existing as WindowClient).navigate(targetUrl);
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
