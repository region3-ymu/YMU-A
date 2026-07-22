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
      <h1 className="text-2xl font-bold tracking-tight">Lists</h1>
      <p className="text-sm opacity-70">Schools &amp; teachers by region</p>
      {(caller.role === "operations_manager" || caller.role === "cpo") && (
        <Link href="/lists/school-years" className="mt-1 text-sm underline opacity-70">
          Manage school years →
        </Link>
      )}
      {(schoolsError || teachersError) && (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
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
