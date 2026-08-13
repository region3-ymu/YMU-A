"use client";

import { signOut } from "@/app/(auth)/actions";

// Signing out has to take the cached pages with it.
//
// The page caches hold rendered, authenticated screens — a teacher's schedule,
// their classes, their school. `supabase.auth.signOut()` clears the session but
// cannot touch the Cache Storage API, which is client-only, so without this
// those screens stay readable offline on the device after the next person picks
// it up. That was always true; it mattered less at serwist's 24-hour default
// and matters more now the page cache is kept for a week.
//
// Names must match the ones in src/app/sw.ts. Kept as a literal rather than
// imported because the service worker is a separate build target.
const PAGE_CACHES = ["ymu-pages", "ymu-pages-rsc"];

export default function SignOutButton() {
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Never block the sign-out itself: an old browser without Cache Storage,
    // or a storage error, must not leave someone stuck signed in.
    try {
      if (typeof caches !== "undefined") {
        await Promise.all(PAGE_CACHES.map((name) => caches.delete(name)));
      }
    } catch {
      /* best effort — signing out is the part that must happen */
    }
    await signOut();
  }

  return (
    <form onSubmit={handleSubmit}>
      <button
        type="submit"
        className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high"
        aria-label="Sign out"
        title="Sign out"
      >
        <span className="material-symbols-outlined text-xl" aria-hidden>
          logout
        </span>
      </button>
    </form>
  );
}
