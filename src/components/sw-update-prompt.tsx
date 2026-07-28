"use client";

import { useEffect, useRef, useState } from "react";
import { useSerwist } from "@serwist/turbopack/react";

// Solves the "I deployed a new version but users are stuck on the old one"
// problem — the exact thing that made a stale bundle (built before an env var
// was set) keep throwing "missing VAPID key" on some devices even after the
// fix shipped. Now built on the canonical "waiting worker" flow (the SW sets
// skipWaiting:false, see src/app/sw.ts), which is deterministic:
//
//   1. FORCE update checks. Browsers otherwise may not re-check the service
//      worker script for up to ~24h, so a device can run yesterday's bundle
//      indefinitely. We call serwist.update() on mount, on an interval, and
//      whenever the tab regains focus.
//   2. A new worker installs and, because skipWaiting is off, sits in the
//      "waiting" state instead of taking over silently. That waiting worker
//      IS the pending update — show the banner.
//   3. On click, tell the waiting worker to skipWaiting. It activates,
//      clientsClaim makes it take control, "controlling" fires, and only THEN
//      do we reload — once — into the fresh assets. No 4s-timeout guesswork.
export default function SwUpdatePrompt() {
  const { serwist } = useSerwist();
  const [updateReady, setUpdateReady] = useState(false);
  const [reloading, setReloading] = useState(false);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (!serwist) return;
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;

    let cancelled = false;

    // A worker in "waiting" is unambiguously an installed-but-not-yet-applied
    // update (a first-ever install goes installing -> activating, never
    // "waiting", so this can't misfire on the initial visit).
    const onWaiting = () => {
      if (!cancelled) setUpdateReady(true);
    };
    // The freshly-activated worker has taken control. If we asked for it (the
    // user clicked Actualizar), the new assets are now live — reload into
    // them. Guarded by reloadingRef so a background update in ANOTHER tab
    // can't yank a reload out from under this one; this tab just keeps showing
    // its banner until the user acts.
    const onControlling = () => {
      if (reloadingRef.current) window.location.reload();
    };
    serwist.addEventListener("waiting", onWaiting);
    serwist.addEventListener("controlling", onControlling);

    // The "waiting" event only fires for updates that install while THIS page
    // is open with the listener attached. If a worker finished installing
    // earlier (e.g. during a previous visit) it's already sitting in waiting
    // and no event will replay — so check the registration directly on mount.
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (!cancelled && reg?.waiting) setUpdateReady(true);
      })
      .catch(() => {
        /* no registration yet — the update() checks below will catch it */
      });

    const check = () => {
      // serwist.update() can throw SYNCHRONOUSLY ("Cannot update a Serwist
      // instance without being registered") if register() hasn't resolved
      // yet — a real console error confirmed live, not just theoretical. A
      // bare .catch() only guards an async rejection, not a sync throw, so
      // this needs a try/catch around the call itself too. Harmless either
      // way — the 60s interval retries once registration has caught up.
      try {
        serwist.update()?.catch(() => {
          /* offline / transient — the interval retries */
        });
      } catch {
        /* not registered yet — the interval retries */
      }
    };
    check();
    const interval = setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      serwist.removeEventListener("waiting", onWaiting);
      serwist.removeEventListener("controlling", onControlling);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serwist]);

  function applyUpdate() {
    reloadingRef.current = true;
    setReloading(true);
    // Ask the waiting worker to take over. It activates, claims this page, and
    // fires "controlling" (handled above) which does the single reload. The
    // timeout is only a safety net for the rare case controlling never
    // arrives — not the primary path, unlike the old skipWaiting:true design.
    serwist?.messageSkipWaiting();
    setTimeout(() => window.location.reload(), 3000);
  }

  if (!updateReady) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[60] mx-auto flex w-full max-w-xl items-center justify-between gap-3 bg-inverse-surface px-4 py-3 text-inverse-on-surface shadow-lg sm:top-4 sm:rounded-full">
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className="material-symbols-outlined text-base" aria-hidden>
          system_update
        </span>
        Hay una versión nueva de la app.
      </span>
      <button
        type="button"
        onClick={applyUpdate}
        disabled={reloading}
        className="shrink-0 text-sm font-bold text-primary-fixed disabled:opacity-60"
      >
        {reloading ? "Actualizando…" : "Actualizar"}
      </button>
    </div>
  );
}
