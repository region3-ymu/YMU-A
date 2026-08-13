"use client";

import { useEffect, useState } from "react";
import { countPending, getCachedNextClass } from "@/lib/offline/queue";
import type { ScheduleCacheRow } from "@/lib/offline/db";
import { formatTimeRange } from "@/lib/format/datetime";

// What the offline screen can still tell a teacher standing in a school with
// no signal. Until now it told them nothing: it said the page was unavailable
// and stopped, which is the moment they decide the app is broken and reach for
// paper.
//
// Everything here is read from this device. `getCachedNextClass()` has existed
// since the offline work landed and was written on every render of the
// clocking screen — but nothing ever read it back, so the app's only offline
// memory of "which class is next" went unused while offline behaviour depended
// entirely on stale cached HTML. This is its first reader.
export default function OfflineStatus() {
  const [pending, setPending] = useState<number | null>(null);
  const [nextClass, setNextClass] = useState<ScheduleCacheRow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Never let a storage failure blank the screen — private browsing and a
      // full disk both throw here, and the guidance below is worth showing
      // even when nothing can be read.
      const [count, cached] = await Promise.all([
        countPending().catch(() => 0),
        getCachedNextClass().catch(() => null),
      ]);
      if (cancelled) return;
      setPending(count);
      setNextClass(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="grid w-full max-w-sm gap-3 text-left">
      {/* The reassurance comes first and in the strongest terms available.
          A teacher who already tapped Clock in needs to know the tap was kept
          before they need anything else — that is the difference between
          trusting the app and filling in the paper log twice. */}
      {loaded && pending !== null && pending > 0 && (
        <div className="rounded-2xl bg-tertiary-container p-4 text-on-tertiary-container">
          <p className="flex items-center gap-2 font-semibold">
            <span className="material-symbols-outlined" aria-hidden>cloud_done</span>
            {pending === 1 ? "1 clock-in saved" : `${pending} clock-ins saved`}
          </p>
          <p className="mt-1 text-sm">
            Saved on this phone with the time you actually tapped. It sends itself as soon as
            you have signal — you don&apos;t need to do anything, and you don&apos;t need to
            keep this page open.
          </p>
        </div>
      )}

      {loaded && nextClass && (
        <div className="rounded-2xl bg-surface-container p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
            Your next class, saved on this phone
          </p>
          <p className="mt-1 font-semibold text-on-surface">
            {nextClass.summary?.trim() || "Class"}
          </p>
          <p className="text-sm text-on-surface-variant">
            {nextClass.start_at ? formatTimeRange(nextClass.start_at, nextClass.end_at) : ""}
            {nextClass.school_name ? ` · ${nextClass.school_name}` : ""}
          </p>
        </div>
      )}

      <div className="rounded-2xl bg-surface-container p-4">
        <p className="font-semibold text-on-surface">Try the clock-in screen</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          If you&apos;ve opened it on this phone before, it still works without signal.
        </p>
        <a
          href="/clocking"
          className="mt-3 inline-flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>schedule</span>
          Open clock-in
        </a>
      </div>

      {/* Shown to everyone, because the teacher who most needs it is the one
          with nothing cached — and for them, every panel above is missing. */}
      <div className="rounded-2xl bg-surface-container-low p-4">
        <p className="font-semibold text-on-surface">If nothing here works</p>
        <ul className="mt-2 grid gap-2 text-sm text-on-surface-variant">
          <li>
            <strong className="text-on-surface">Open the app once where you have signal</strong> —
            outside the building, or before you leave home. Installing it is not enough; it has
            to load the clock-in screen once to keep a copy on your phone.
          </li>
          <li>
            <strong className="text-on-surface">Open it from the home-screen icon</strong>, not
            from a browser tab. Same app, but the icon is the one set up to work offline.
          </li>
          <li>
            <strong className="text-on-surface">Weak signal is worse than none.</strong> If the
            app hangs rather than loading, turn airplane mode ON for a moment — it stops the app
            waiting on a signal that never arrives and makes it use the copy on your phone.
          </li>
          <li>
            Still stuck? Note the time you started teaching and tell your Regional Manager. They
            can record the class for you — you will not lose the hours.
          </li>
        </ul>
      </div>
    </div>
  );
}
