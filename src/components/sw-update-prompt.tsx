"use client";

import { useEffect, useRef, useState } from "react";
import { useSerwist } from "@serwist/turbopack/react";

// Solves the "I deployed a new version but users are stuck on the old one"
// problem — the exact thing that made a stale bundle (built before an env var
// was set) keep throwing "missing VAPID key" on some devices even after the
// fix shipped. Two halves:
//   1. FORCE update checks. Browsers otherwise may not re-check the service
//      worker script for up to ~24h, so a device can run yesterday's bundle
//      indefinitely. We call serwist.update() on mount, on an interval, and
//      whenever the tab regains focus.
//   2. When a NEW service worker takes control (our SW uses skipWaiting +
//      clientsClaim, so it activates immediately), show a small "new version"
//      banner with a button that reloads into the fresh assets. We only show
//      it when a controller already existed at mount — the very first
//      install shouldn't read as "an update is available".
export default function SwUpdatePrompt() {
  const { serwist } = useSerwist();
  const [updateReady, setUpdateReady] = useState(false);
  const [reloading, setReloading] = useState(false);
  const reloadingRef = useRef(false);
  const hadControllerRef = useRef(false);

  useEffect(() => {
    hadControllerRef.current =
      typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;
  }, []);

  useEffect(() => {
    if (!serwist) return;

    // A waiting worker is unambiguously a pending update.
    const onWaiting = () => setUpdateReady(true);
    // controlling fires on first install too (no prior controller) — only
    // treat it as an update when the page was already controlled. If we're
    // the ones who triggered this (reloadingRef, set by applyUpdate()), the
    // new worker has now ACTUALLY taken over — only now is it safe to
    // reload. Reloading immediately after messageSkipWaiting() (without
    // waiting for this event) races the activation and can land the page in
    // a broken intermediate state — confirmed live (a real device got stuck
    // on a blank/dead page after tapping "Actualizar").
    const onControlling = () => {
      if (reloadingRef.current) {
        window.location.reload();
        return;
      }
      if (hadControllerRef.current) setUpdateReady(true);
    };
    serwist.addEventListener("waiting", onWaiting);
    serwist.addEventListener("controlling", onControlling);

    const check = () => {
      serwist.update().catch(() => {
        /* offline / transient — the interval retries */
      });
    };
    check();
    const interval = setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      serwist.removeEventListener("waiting", onWaiting);
      serwist.removeEventListener("controlling", onControlling);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serwist]);

  function applyUpdate() {
    reloadingRef.current = true;
    setReloading(true);
    // Tell the waiting worker to take over. The actual reload happens in
    // onControlling() above, once it genuinely has — NOT immediately here.
    serwist?.messageSkipWaiting();
    // Safety net: if 'controlling' never fires for some reason (e.g. the
    // browser already handled it, or a rare platform quirk), don't leave the
    // user stuck looking at an unresponsive "Actualizando…" button forever.
    setTimeout(() => window.location.reload(), 4000);
  }

  if (!updateReady) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[60] mx-auto flex w-full max-w-xl items-center justify-between gap-3 border-b border-accent bg-accent px-4 py-2 text-accent-foreground shadow sm:top-4 sm:rounded-2xl sm:border">
      <span className="text-sm font-semibold">Hay una versión nueva de la app.</span>
      <button
        type="button"
        onClick={applyUpdate}
        disabled={reloading}
        className="shrink-0 rounded-lg bg-background px-3 py-1.5 text-sm font-semibold text-foreground disabled:opacity-60"
      >
        {reloading ? "Actualizando…" : "Actualizar"}
      </button>
    </div>
  );
}
