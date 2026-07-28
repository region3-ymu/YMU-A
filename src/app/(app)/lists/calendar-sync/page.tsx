import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { getSyncableSchools } from "./actions";
import SyncForm from "./sync-form";

export const metadata: Metadata = { title: "Sync calendars" };

export default async function CalendarSyncPage() {
  await requireRole(...MANAGER_ROLES);
  const schools = await getSyncableSchools();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header>
        <Link
          href="/lists"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary"
        >
          ← Lists
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>
            calendar_month
          </span>
          Sync calendars
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Google Calendar syncs automatically every 5 minutes. Use this to
          pull a change in immediately instead of waiting, or to retry a
          specific school after fixing its calendar sharing.
        </p>
      </header>

      {schools.length === 0 ? (
        <p className="rounded-2xl bg-surface-container p-6 text-sm text-on-surface-variant shadow-sm">
          No school has a Google Calendar linked yet — link one from the
          &ldquo;Calendars needing attention&rdquo; queue on{" "}
          <Link href="/schedules" className="font-medium text-primary underline">
            Schedules
          </Link>{" "}
          first.
        </p>
      ) : (
        <SyncForm schools={schools} />
      )}
    </main>
  );
}
