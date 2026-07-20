"use client";

import { usePathname, useRouter } from "next/navigation";

// Every (app) page but home gets this in the header — there was previously no
// way to navigate up a level except clicking the "YMU-A" logo back to home.
// Falls back to "/" when there's no in-app history to go back to (e.g. a
// direct link/refresh landed here with an empty history stack).
export default function BackButton() {
  const pathname = usePathname();
  const router = useRouter();

  if (pathname === "/") return null;

  function goBack() {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="Back"
      className="flex items-center gap-1 text-sm opacity-70 transition-opacity hover:opacity-100"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Back
    </button>
  );
}
