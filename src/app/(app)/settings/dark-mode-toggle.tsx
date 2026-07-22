"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "ymu-a-theme";

type Theme = "light" | "dark";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Device-local only (user-confirmed) — no schema column, no round-trip. The
// root layout's beforeInteractive script (src/app/layout.tsx) already
// applied any stored override before this ever mounts, so the only job here
// is reflecting that into the toggle's initial UI state and writing changes
// back. Reads localStorage at mount, not at useState-init time, matching the
// hydration-safe pattern used by offline-indicator.tsx.
export default function DarkModeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage/matchMedia are unreadable during SSR.
    setDark(stored ? stored === "dark" : systemPrefersDark());
  }, []);

  function apply(nextDark: boolean) {
    setDark(nextDark);
    const theme: Theme = nextDark ? "dark" : "light";
    localStorage.setItem(STORAGE_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
  }

  return (
    <label className="flex items-center justify-between gap-3 rounded-xl border border-foreground/10 p-4">
      <span>
        <span className="block font-semibold">Dark mode</span>
        <span className="block text-sm opacity-70">Stored on this device only.</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={dark}
        checked={dark}
        onChange={(e) => apply(e.target.checked)}
        className="h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-foreground/20 transition-colors checked:bg-accent relative before:absolute before:left-0.5 before:top-0.5 before:h-5 before:w-5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-5"
      />
    </label>
  );
}
