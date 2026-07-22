import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { navForRole } from "@/lib/auth/roles";
import { getOpenSession } from "@/lib/attendance/queries";
import PushOnboardingPrompt from "@/components/push-onboarding-prompt";

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
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Hi, {profile.full_name.split(" ")[0]}
        </h1>
        <p className="text-sm opacity-70">Young Musicians Unite — Attendance</p>
      </header>

      {openSession && (
        <Link
          href="/feedback"
          className="mb-6 block rounded-2xl border border-accent bg-accent/10 p-4 transition-colors hover:bg-accent/15"
        >
          <p className="font-semibold text-accent">Feedback required</p>
          <p className="mt-0.5 text-sm opacity-80">
            You&apos;re still clocked in to{" "}
            <span className="font-medium">{openSession.event?.summary?.trim() || "your last class"}</span>. Submit your
            feedback to clock out — you can&apos;t clock into another class until you do.
          </p>
        </Link>
      )}
      <PushOnboardingPrompt />
      <ul className="grid grid-cols-2 gap-3">
        {nav.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="block rounded-2xl border border-foreground/10 p-4 transition-colors hover:border-accent"
            >
              <p className="font-semibold">{item.label}</p>
              <p className="text-xs opacity-60">{item.note}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
