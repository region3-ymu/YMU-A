import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import {
  REGION_LABELS,
  ROLE_LABELS,
  type AppRole,
  type Region,
} from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import RowForm from "./row-form";

export const metadata: Metadata = { title: "Team" };

type Row = {
  id: string;
  full_name: string;
  phone: string | null;
  role: AppRole;
  region: Region | null;
  archived_at: string | null;
};

export default async function UsersPage() {
  const caller = await requireRole("operations_manager", "cpo");

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("profiles")
    .select("id, full_name, phone, role, region, archived_at")
    .order("full_name");

  // Mirrors promote_user()'s rules so the UI doesn't offer doomed submits:
  // cpo is never assignable; OMs can't touch other OMs or the CPO.
  const assignableRoles = (row: Row): AppRole[] | null => {
    if (row.id === caller.id) return null;
    if (row.role === "cpo") return null;
    if (row.role === "operations_manager" && caller.role !== "cpo") return null;
    return caller.role === "cpo"
      ? ["teacher", "regional_manager", "operations_manager"]
      : ["teacher", "regional_manager"];
  };

  return (
    <main className="flex flex-1 flex-col p-6">
      <h1 className="text-2xl font-bold tracking-tight">Team</h1>
      <p className="mt-1 text-sm opacity-70">
        Promote teachers to Regional Manager and assign their region
        {caller.role === "cpo" ? ", or appoint Operations Managers" : ""}.
      </p>
      {error && (
        <p role="alert" className="mt-6 text-sm text-red-600 dark:text-red-400">
          Couldn&rsquo;t load the team: {error.message}
        </p>
      )}
      <ul className="mt-6 flex flex-col gap-3">
        {(rows ?? []).map((row) => {
          const assignable = assignableRoles(row as Row);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-foreground/10 p-4"
            >
              <div>
                <p className="font-semibold">
                  {row.full_name}
                  {row.id === caller.id && (
                    <span className="ml-2 text-xs opacity-60">(you)</span>
                  )}
                  {row.archived_at && (
                    <span className="ml-2 rounded-full border border-foreground/20 px-2 py-0.5 text-xs opacity-60">
                      Archived
                    </span>
                  )}
                </p>
                <p className="text-xs opacity-60">
                  {ROLE_LABELS[row.role as AppRole]}
                  {row.region
                    ? ` — ${REGION_LABELS[row.region as Region]}`
                    : ""}
                  {row.phone ? ` · ${row.phone}` : ""}
                </p>
              </div>
              {assignable && (
                <RowForm
                  targetId={row.id}
                  currentRole={row.role as AppRole}
                  currentRegion={row.region as Region | null}
                  assignableRoles={assignable}
                />
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
