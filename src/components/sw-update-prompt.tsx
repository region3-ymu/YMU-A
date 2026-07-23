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
    // treat it as an update when the page was already controlled.
    const onControlling = () => {
      if (hadControllerRef.current && !reloadingRef.current) setUpdateReady(true);
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
    // Tell any waiting worker to take over, then reload into the new assets.
    serwist?.messageSkipWaiting();
    window.location.reload();
  }

  if (!updateReady) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[60] mx-auto flex w-full max-w-xl items-center justify-between gap-3 border-b border-accent bg-accent px-4 py-2 text-accent-foreground shadow sm:top-4 sm:rounded-2xl sm:border">
      <span className="text-sm font-semibold">Hay una versión nueva de la app.</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="shrink-0 rounded-lg bg-background px-3 py-1.5 text-sm font-semibold text-foreground"
      >
        Actualizar
      </button>
    </div>
  );
}
