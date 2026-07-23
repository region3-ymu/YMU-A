"use client";

import { useEffect, useState } from "react";

const DISMISSED_KEY = "ymu-a-install-prompt-dismissed";

// Chrome/Edge (Android + desktop) fire this before showing their own native
// install UI; capturing it lets us show our own banner/button instead of
// relying on the browser's default entry point (which on Android surfaces as
// a not-very-discoverable "Install app" item, and doesn't exist on iOS at all
// — see below). Not in the standard DOM typings.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isIOS(): boolean {
  // Mirrors src/lib/push.ts's isIOS() — iPadOS 13+ reports as "MacIntel" but
  // with touch support, unlike a real Mac.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Universal "install this app" banner. Android/Chrome/Edge get a real
// install button wired to the captured beforeinstallprompt event; Safari
// never fires that event at all (Apple doesn't support triggering the
// add-to-home-screen flow programmatically), so iOS gets manual
// instructions instead. Shown app-wide (mounted in the root layout, signed
// in or not) so anyone landing on the site sees a way to install it,
// regardless of platform — not just the lucky Android users who noticed
// their browser's own native prompt. Dismissible, persisted in localStorage
// so it doesn't nag every visit.
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosPrompt, setIosPrompt] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage/UA/display-mode are unavailable during SSR.
    setDismissed(Boolean(localStorage.getItem(DISMISSED_KEY)));

    if (isStandalone()) return; // already installed — nothing to prompt.

    if (isIOS()) {
      setIosPrompt(true);
      return;
    }

    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  if (dismissed || (!deferredPrompt && !iosPrompt)) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-xl flex-col gap-2 border-t border-accent bg-background p-4 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] sm:bottom-4 sm:rounded-2xl sm:border">
      {iosPrompt ? (
        <>
          <p className="text-sm font-semibold text-accent">Install YMU-A on your phone</p>
          <p className="text-xs opacity-80">
            Tap the <strong>Share</strong> icon in Safari, then <strong>&quot;Add to Home Screen&quot;</strong> — it
            opens like a real app and works offline.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-accent">Install YMU-A on your phone</p>
          <p className="text-xs opacity-80">Add it to your home screen for quick, full-screen access.</p>
        </>
      )}
      <div className="mt-1 flex gap-3">
        {deferredPrompt && (
          <button
            type="button"
            onClick={handleInstall}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground"
          >
            Install
          </button>
        )}
        <button type="button" onClick={dismiss} className="text-sm font-semibold opacity-70 underline">
          Not now
        </button>
      </div>
    </div>
  );
}
