"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/lib/auth/roles";

/**
 * The tapped tab, while its page is still coming.
 *
 * This is the direct answer to "la gente le da clic varias veces porque no se
 * abre rápido" (YMU 2026-08-21). The loading.tsx files cover the page body;
 * this covers the half-second before that, when the only thing the user can
 * see is the bar they just touched.
 *
 * Per Next's own guidance the element is always rendered at a fixed size and
 * only its opacity changes — an indicator that appears from nothing shifts the
 * icon it sits under, on the one control the user is actively aiming at.
 *
 * useLinkStatus must be a descendant of the Link, which is why this is its own
 * component. It returns { pending: false } for an already-prefetched route, so
 * on a fast navigation nothing flashes.
 */
function TapPending() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-0 rounded-full border-2 border-primary transition-opacity duration-150 ${
        pending ? "animate-pulse opacity-100" : "opacity-0"
      }`}
    />
  );
}

// Mobile-first bottom navigation bar (Stitch design). Fixed to the viewport
// bottom with a translucent, blurred surface. The active tab is derived from
// the current path so it stays correct across in-app navigation.
export default function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-outline-variant/40 bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      {/* items-stretch + min-w-0 everywhere below: the bar has to FIT, not
          overflow. Measured at 402px (iPhone 17 Pro's logical width) the five
          tabs ended at x=398 — four pixels of margin, which iOS spends on
          slightly wider system-font metrics, so the last tab (Schedules) fell
          off the edge while Android, a few points wider, kept it. Nothing here
          may have a minimum width any more. */}
      <ul className="mx-auto flex w-full max-w-3xl items-stretch justify-around px-0.5">
        {items.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-16 w-full min-w-0 flex-col items-center justify-center gap-1 px-0.5 transition-colors ${
                  active ? "text-primary" : "text-on-surface-variant"
                }`}
              >
                <span
                  className={`relative flex h-8 w-full max-w-12 items-center justify-center rounded-full transition-colors ${
                    active ? "bg-primary-container text-on-primary-container" : ""
                  }`}
                >
                  <span
                    className={`material-symbols-outlined text-2xl ${active ? "filled" : ""}`}
                    aria-hidden
                  >
                    {item.icon}
                  </span>
                  <TapPending />
                  {/* Count of things waiting. Sits on the icon rather than
                      beside the label so it reads at a glance without the tab
                      widths shifting when the number changes. */}
                  {item.badge != null && item.badge > 0 && (
                    <span
                      className={`absolute -right-0.5 -top-0.5 min-w-5 rounded-full px-1 text-center text-[10px] font-bold leading-5 ${
                        item.badgeUrgent === false
                          ? "bg-primary text-on-primary"
                          : "bg-error text-on-error"
                      }`}
                    >
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </span>
                {/* Truncates rather than widening its tab. A clipped word is
                    survivable; a tab pushed off the screen is not. */}
                <span className="w-full truncate text-center text-[10px] font-medium leading-none">
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
