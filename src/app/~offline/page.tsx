import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline",
};

export default function OfflinePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-semibold">You&apos;re offline</h1>
      <p className="max-w-sm text-sm opacity-80">
        This page isn&apos;t available offline yet. Your saved schedule and any
        pending clock-ins are kept on this device and will sync automatically
        when you&apos;re back online.
      </p>
    </main>
  );
}
