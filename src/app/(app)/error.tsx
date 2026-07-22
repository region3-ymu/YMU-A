"use client";

// PRD §14: database connection errors need a clear message and a next step.
// Most server actions already return a friendly {error} to render inline
// (see users/actions.ts, flags/actions.ts, etc.) — this boundary only catches
// what those can't: an unexpected exception thrown during render (e.g. a
// Server Component's own Supabase read failing outright) instead of a
// returned {error}.

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        Something went wrong loading this page. This is usually temporary —
        check your connection and try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground"
      >
        Try again
      </button>
    </main>
  );
}
