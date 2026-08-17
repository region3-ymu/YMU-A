"use client";

import { useEffect } from "react";

// A red count on the home-screen icon.
//
// This is the only insistent channel Apple leaves open to a web app. On iPhone
// a PWA cannot set a custom notification sound, cannot control vibration,
// cannot mark itself Time Sensitive, and cannot survive a Focus mode or the
// Scheduled Summary — so a push that arrives at a bad moment is simply gone.
// The badge is different: it is not an interruption, it just sits on the icon
// and does not go away until the work is done. For "I forgot to clock in" that
// is a better fit than a louder alert would be.
//
// Supported on iOS 16.4+ (installed to the Home Screen) and on Chrome/Edge for
// installed web apps. Everywhere else setAppBadge is simply absent, hence the
// capability check rather than a polyfill.
type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export default function AppBadge({ count }: { count: number }) {
  useEffect(() => {
    const nav = navigator as BadgingNavigator;
    if (typeof nav.setAppBadge !== "function") return;

    // Clearing explicitly rather than setting 0: on some platforms setAppBadge(0)
    // shows a dot instead of removing the badge.
    const apply =
      count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.() ?? nav.setAppBadge(0);

    // A rejected promise here is never actionable — the user may have revoked
    // notification permission, which is their call — so it is swallowed rather
    // than logged on every navigation.
    void apply?.catch(() => {});
  }, [count]);

  return null;
}
