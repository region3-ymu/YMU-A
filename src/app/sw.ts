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
