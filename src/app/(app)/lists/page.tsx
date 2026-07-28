import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import ListsExplorer from "./lists-explorer";
import type { School, Teacher } from "./types";

export const metadata: Metadata = { title: "Lists" };

export default async function ListsPage() {
  const caller = await requireRole(...MANAGER_ROLES);

  const supabase = await createClient();
  const [{ data: schools, error: schoolsError }, { data: teachers, error: teachersError }] =
    await Promise.all([
      supabase
        .from("schools")
        .select(
          "id, name, address, contact_name, contact_phone, lat, lng, geocode_source, geofence_radius_m, region",
        )
        .order("name"),
      supabase.rpc("teacher_directory"),
    ]);

  return (
    <main className="flex flex-1 flex-col gap-2 p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
        <span className="material-symbols-outlined text-primary" aria-hidden>
          groups
        </span>
        Lists
      </h1>
      <p className="text-sm text-on-surface-variant">Schools &amp; teachers by region</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Link
          href="/lists/calendar-sync"
          className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>
            calendar_month
          </span>
          Sync calendars →
        </Link>
        {(caller.role === "operations_manager" || caller.role === "cpo") && (
          <Link
            href="/lists/school-years"
            className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>
              school
            </span>
            Manage school years →
          </Link>
        )}
      </div>
      {(schoolsError || teachersError) && (
        <p role="alert" className="mt-4 rounded-2xl bg-error-container px-4 py-3 text-sm text-on-error-container shadow-sm">
          Couldn&rsquo;t load lists: {(schoolsError ?? teachersError)?.message}
        </p>
      )}
      <div className="mt-4">
        <ListsExplorer
          schools={(schools ?? []) as School[]}
          teachers={(teachers ?? []) as Teacher[]}
          callerRole={caller.role}
        />
      </div>
    </main>
  );
}
