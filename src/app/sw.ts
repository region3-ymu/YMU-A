import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { ExpirationPlugin, NetworkFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Pages a teacher has already opened, kept so they still load inside a school
// with no signal. Named ours rather than reusing serwist's "pages"/"others" so
// the activate handler below can drop it without touching anything else.
const PAGE_CACHE = "ymu-pages";
const RSC_CACHE = "ymu-pages-rsc";

// A WEEK, not serwist's default 24 hours. A teacher who works Tuesdays and
// Thursdays would otherwise arrive at every single class with an expired cache
// and no way to clock in. Safe to extend for two reasons: NetworkFirst only
// ever reads the cache when the network has already failed, so nobody online
// sees week-old content; and the activate handler below wipes this on every
// deploy, so "stale" is bounded by the last release, not by this number.
const PAGE_MAX_AGE_S = 7 * 24 * 60 * 60;

// THE IMPORTANT ONE. Serwist's default page strategy is NetworkFirst with no
// timeout, and that is precisely backwards for a school building: with NO
// signal the fetch fails immediately and the cache is served, so the app
// works — but with WEAK signal the browser believes it is online, so the app
// sits waiting on a network that will never answer. The teacher gives up long
// before it falls back. Three seconds, then serve what we have.
const pageOptions = {
  networkTimeoutSeconds: 3,
  plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: PAGE_MAX_AGE_S })],
};

// Only in production: serwist's dev defaultCache is NetworkOnly on purpose,
// and caching pages while developing hides changes behind a stale worker.
const pageCaching =
  process.env.NODE_ENV === "production"
    ? [
        {
          // A cold open of the app — tapping the home-screen icon.
          matcher: ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
            sameOrigin && request.destination === "document" && !url.pathname.startsWith("/api/"),
          handler: new NetworkFirst({ cacheName: PAGE_CACHE, ...pageOptions }),
        },
        {
          // In-app navigation. Next sends these as RSC fetches rather than
          // document requests, so the rule above never sees them — without
          // this, moving from Home to Clocking offline fails even though the
          // cold open works.
          matcher: ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
            sameOrigin && request.headers.get("RSC") === "1" && !url.pathname.startsWith("/api/"),
          handler: new NetworkFirst({ cacheName: RSC_CACHE, ...pageOptions }),
        },
      ]
    : [];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // skipWaiting is DELIBERATELY false. With skipWaiting:true a new worker
  // activates and claims control the instant it installs, so it never enters
  // the "waiting" state — which made the "Actualizar" banner rely on a racy
  // controllerchange + 4s-timeout reload that could leave the button stuck.
  // Waiting instead makes the update land deterministically, so the banner
  // (src/components/sw-update-prompt.tsx) can offer it and the click reliably
  // activates it -> controllerchange -> single reload. clientsClaim stays true
  // so a first-time visitor is controlled within their first visit (offline
  // works immediately) and so the click-activated worker claims the page,
  // guaranteeing the controllerchange the reload waits on.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  // Ours first: serwist's list ends in catch-alls that would swallow these.
  runtimeCaching: [...pageCaching, ...defaultCache],
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

// Drop the cached pages whenever a new worker takes over — which is exactly
// once per deploy, since `activate` fires only for a worker that has just
// replaced another.
//
// This is what makes the week-long expiry above safe. Cached HTML references
// the build's hashed JS chunks; serwist cleans the old build's chunks out of
// the precache on activation, so week-old HTML kept across a deploy would ask
// for files that no longer exist anywhere and render broken — offline, with no
// way for the teacher to tell why. Better to start a release with an empty
// page cache: the first online open refills it, and the offline screen below
// still knows the next class from IndexedDB in the meantime.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all([caches.delete(PAGE_CACHE), caches.delete(RSC_CACHE)]);
    })(),
  );
});

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
