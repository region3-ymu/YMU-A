"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/lib/auth/roles";

// Mobile-first bottom navigation bar (Stitch design). Fixed to the viewport
// bottom with a translucent, blurred surface. The active tab is derived from
// the current path so it stays correct across in-app navigation.
export default function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-outline-variant/40 bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      <ul className="mx-auto flex max-w-3xl items-stretch justify-around px-1">
        {items.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-16 min-w-16 flex-col items-center justify-center gap-1 transition-colors ${
                  active ? "text-primary" : "text-on-surface-variant"
                }`}
              >
                <span
                  className={`relative flex h-8 w-14 items-center justify-center rounded-full transition-colors ${
                    active ? "bg-primary-container text-on-primary-container" : ""
                  }`}
                >
                  <span
                    className={`material-symbols-outlined text-2xl ${active ? "filled" : ""}`}
                    aria-hidden
                  >
                    {item.icon}
                  </span>
                  {/* Count of things waiting. Sits on the icon rather than
                      beside the label so it reads at a glance without the tab
                      widths shifting when the number changes. */}
                  {item.badge != null && item.badge > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-error px-1 text-center text-[10px] font-bold leading-5 text-on-error">
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium leading-none">
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
