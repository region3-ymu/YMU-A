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
      className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
    >
      <span className="material-symbols-outlined text-xl" aria-hidden>
        arrow_back
      </span>
    </button>
  );
}
