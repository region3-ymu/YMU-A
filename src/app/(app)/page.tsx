import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { navForRole } from "@/lib/auth/roles";
import { getOpenSession } from "@/lib/attendance/queries";
import PushOnboardingPrompt from "@/components/push-onboarding-prompt";

// Rotating tint for the bento tile icons (Stitch look — each tile's icon sits
// in a soft colored disc). Indexed round-robin across the menu items.
const TILE_TINTS = [
  "bg-primary-container text-on-primary-container",
  "bg-tertiary-container text-on-tertiary-container",
  "bg-secondary-container text-on-secondary-container",
  "bg-surface-variant text-on-surface-variant",
];

export default async function Home() {
  const profile = await requireProfile();
  // Teacher with an unfinished class => re-prompt the feedback gate on login.
  // Only clock-in is blocked (the nav below stays reachable), so this is a
  // prominent prompt rather than a hard redirect.
  const openSession = profile.role === "teacher" ? await getOpenSession() : null;
  // The Clocking tile reflects which action is actually available right now
  // (user-confirmed): with an open session, clocking in is blocked anyway, so
  // the tile becomes the "Clock out" entry point instead of restating
  // "Clocking" as if nothing were pending.
  const nav = navForRole(profile.role).map((item) =>
    item.href === "/clocking" && openSession
      ? { ...item, label: "Clock out", note: "Submit feedback to finish" }
      : item,
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4">
      <header className="pt-2">
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          Hi, {profile.full_name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-on-surface-variant">
          Young Musicians Unite — Attendance
        </p>
      </header>

      {openSession && (
        <Link
          href="/feedback"
          className="block rounded-2xl bg-error-container p-4 text-on-error-container shadow-sm transition-transform active:scale-[0.99]"
        >
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-error" aria-hidden>
              warning
            </span>
            <div className="flex-1">
              <p className="font-bold">Feedback required</p>
              <p className="mt-0.5 text-sm opacity-90">
                You&apos;re still clocked in to{" "}
                <span className="font-semibold">
                  {openSession.event?.summary?.trim() || "your last class"}
                </span>
                . Submit your feedback to clock out.
              </p>
              <span className="mt-3 inline-flex items-center gap-1 rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error">
                Complete now
                <span className="material-symbols-outlined text-base" aria-hidden>
                  arrow_forward
                </span>
              </span>
            </div>
          </div>
        </Link>
      )}

      <PushOnboardingPrompt />

      <ul className="grid grid-cols-2 gap-3">
        {nav.map((item, i) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex h-full flex-col gap-6 rounded-2xl bg-surface-container p-4 shadow-sm transition-transform active:scale-[0.98]"
            >
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-full shadow-sm ${TILE_TINTS[i % TILE_TINTS.length]}`}
              >
                <span className="material-symbols-outlined" aria-hidden>
                  {item.icon}
                </span>
              </span>
              <span className="mt-auto">
                <span className="block font-bold text-on-surface">
                  {item.label}
                </span>
                <span className="mt-0.5 block text-sm text-on-surface-variant">
                  {item.note}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
