import type { Metadata } from "next";
import OfflineStatus from "./offline-status";

export const metadata: Metadata = {
  title: "Offline",
};

// The service worker serves this whenever a page is asked for and neither the
// network nor the cache can produce it. That makes it the LAST thing a teacher
// sees before they give up on the app, so it has to do more than apologise —
// it used to say "this page isn't available offline yet" and stop, which reads
// as "the app is broken" to someone standing in a classroom.
//
// Everything it shows is read from the device (see offline-status.tsx), since
// by definition there is no server to ask.
export default function OfflinePage() {
  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-6 pt-10">
      <div className="text-center">
        <span
          className="material-symbols-outlined text-4xl text-on-surface-variant"
          aria-hidden
        >
          cloud_off
        </span>
        <h1 className="mt-1 text-2xl font-semibold text-on-surface">You&apos;re offline</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Nothing is lost. Here&apos;s what this phone still knows.
        </p>
      </div>
      <OfflineStatus />
    </main>
  );
}
