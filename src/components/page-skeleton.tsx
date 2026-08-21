/**
 * The shape of a page before its data arrives.
 *
 * Every screen in this app is server-rendered on demand and every one of them
 * queries the database, so a tap on the bottom bar used to change nothing on
 * screen until the whole response came back. YMU (2026-08-21): "la gente le da
 * clic varias veces porque no se abre rápido." They were right to — nothing
 * told them the tap had registered.
 *
 * A `loading.tsx` fixes that twice over. It renders the instant the router
 * commits to the navigation, and — per Next's own docs — the fallback is itself
 * prefetched when the link enters the viewport, so for a dynamic route it is
 * the difference between "prefetch nothing" and "prefetch the shell".
 *
 * Deliberately not a spinner. A skeleton in roughly the right shape reads as
 * "your page is coming" rather than "something is happening somewhere", and
 * because the real header renders identically, the swap does not move anything
 * the eye is already tracking.
 *
 * Server Component: no interactivity, so no reason to ship it to the browser.
 */

/** One shimmering block. `animate-pulse` is Tailwind's; no custom keyframes. */
function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface-container-high ${className}`} />;
}

export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <Bar className="h-4 w-2/5" />
      <div className="mt-3 grid gap-2">
        {Array.from({ length: lines }, (_, index) => (
          <Bar key={index} className={index === lines - 1 ? "h-3 w-1/2" : "h-3 w-full"} />
        ))}
      </div>
    </div>
  );
}

/** A row of the pill counters Reports and the dashboard lead with. */
export function SkeletonPills({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: count }, (_, index) => (
        <Bar key={index} className="h-7 w-24 rounded-full" />
      ))}
    </div>
  );
}

/**
 * The real page's own title and subtitle are rendered here as text, not as
 * bars. They are known before any query runs, so showing them is honest and it
 * means the top of the screen never flickers — only the body swaps.
 */
export default function PageSkeleton({
  title,
  subtitle,
  icon,
  pills = 0,
  cards = 4,
  cardLines = 2,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  pills?: number;
  cards?: number;
  cardLines?: number;
}) {
  return (
    <main className="flex flex-1 flex-col gap-2 p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
        {icon && (
          <span className="material-symbols-outlined" aria-hidden>
            {icon}
          </span>
        )}
        {title}
      </h1>
      {subtitle && <p className="text-sm text-on-surface-variant">{subtitle}</p>}

      {/* One live region for the whole fallback. Without it a screen reader
          hears nothing at all during the wait, which is the same problem the
          skeleton solves for everyone else. */}
      <div className="mt-4 grid gap-3" role="status" aria-live="polite">
        <span className="sr-only">Loading {title.toLowerCase()}…</span>
        {pills > 0 && <SkeletonPills count={pills} />}
        {Array.from({ length: cards }, (_, index) => (
          <SkeletonCard key={index} lines={cardLines} />
        ))}
      </div>
    </main>
  );
}
