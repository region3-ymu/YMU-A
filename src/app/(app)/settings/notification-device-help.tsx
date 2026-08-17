"use client";

import { useState } from "react";

// How to make YMU-A's notifications actually audible.
//
// This is instructions rather than a setting because the sound, the vibration
// and whether a notification can interrupt a Focus mode are all decided by the
// phone, not by us. A web app on iOS cannot set a custom sound, cannot control
// vibration, and cannot mark itself Time Sensitive — those need a native app
// with an Apple entitlement. The honest thing is to say so and show the two
// taps that fix it, instead of adding a toggle that quietly does nothing.
//
// Platform is sniffed only to decide which set of steps to open first; both
// are always reachable, because a shared or borrowed phone is common here.
function isApple() {
  if (typeof navigator === "undefined") return true;
  return /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
}

const IOS_STEPS = [
  "Open the iPhone Settings app, then Notifications.",
  "Find YMU-A in the list and tap it.",
  "Turn on Allow Notifications, and choose Immediate Delivery — not Scheduled Summary, which holds reminders until later in the day.",
  "Turn on Sounds so a reminder is audible with the phone in your pocket.",
  "If you use a Focus mode while teaching, add YMU-A to its allowed apps.",
];

const ANDROID_STEPS = [
  "Open the phone's Settings app, then Notifications, then App notifications.",
  "Find YMU-A and tap it.",
  "Set the reminder channel's importance to Urgent so it makes a sound and pops on screen.",
  "If you use Do Not Disturb while teaching, allow YMU-A through it.",
];

export default function NotificationDeviceHelp() {
  const [open, setOpen] = useState<"ios" | "android" | null>(null);
  const applePreferred = isApple();

  return (
    <div className="mt-3 rounded-2xl bg-surface-container p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tertiary-container text-on-tertiary-container"
          aria-hidden
        >
          <span className="material-symbols-outlined">volume_up</span>
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-on-surface">Not hearing your reminders?</p>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            The sound and vibration are set by your phone, not by this app — we can&apos;t change
            them from here. Two taps in your phone&apos;s settings fixes it for good.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setOpen(open === "ios" ? null : "ios")}
          className={`rounded-full px-4 py-1.5 text-sm font-bold ${
            open === "ios"
              ? "bg-primary text-on-primary"
              : "border-2 border-outline text-on-surface"
          }`}
        >
          {applePreferred ? "Show me (iPhone)" : "iPhone"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(open === "android" ? null : "android")}
          className={`rounded-full px-4 py-1.5 text-sm font-bold ${
            open === "android"
              ? "bg-primary text-on-primary"
              : "border-2 border-outline text-on-surface"
          }`}
        >
          {applePreferred ? "Android" : "Show me (Android)"}
        </button>
      </div>

      {open && (
        <ol className="mt-3 grid list-decimal gap-2 pl-5 text-sm text-on-surface">
          {(open === "ios" ? IOS_STEPS : ANDROID_STEPS).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}

      {open === "ios" && (
        <p className="mt-3 text-xs text-on-surface-variant">
          The red number on the app icon works whatever your sound settings are — it stays
          there until you&apos;ve clocked in and sent your feedback.
        </p>
      )}
    </div>
  );
}
