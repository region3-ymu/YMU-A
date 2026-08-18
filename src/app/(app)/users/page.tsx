import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import {
  REGION_LABELS,
  assignableRoles as rolesAssignableBy,
  canAssignManagerRoles,
  canManageTeam,
  displayRole,
  type AppRole,
  type Region,
} from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import ArchiveButton from "./archive-button";
import ClockInExemptButton from "./clock-in-exempt-button";
import CreateAccountForm from "./create-account-form";
import RowForm from "./row-form";

export const metadata: Metadata = { title: "Team" };

type Row = {
  id: string;
  full_name: string;
  phone: string | null;
  role: AppRole;
  region: Region | null;
  archived_at: string | null;
  clock_in_exempt: boolean;
};

export default async function UsersPage() {
  const caller = await requireProfile();
  // Not requireRole: the set is four roles wide now and mirrored by
  // canManageTeam() / current_can_manage_team() (migration 0069).
  if (!canManageTeam(caller.role, caller.is_app_admin)) redirect("/");

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("profiles")
    .select("id, full_name, phone, role, job_title, region, archived_at, clock_in_exempt")
    .order("full_name");

  // Mirrors promote_user()'s rules so the UI doesn't offer doomed submits:
  // cpo is never assignable, nobody re-roles themselves here, and an existing
  // Operations Manager is the CPO's or an administrator's to change.
  const assignableFor = (row: Row): AppRole[] | null => {
    if (row.id === caller.id) return null;
    if (row.role === "cpo") return null;
    // A manager's row is only editable by someone who may change manager roles.
    // Showing an Academic Manager a dropdown whose only option is "teacher" on a
    // Regional Manager's row would be offering a demotion the RPC then refuses.
    if (row.role !== "teacher" && !canAssignManagerRoles(caller.role)) return null;
    return rolesAssignableBy(caller.role);
  };

  return (
    <main className="flex flex-1 flex-col p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
        <span className="material-symbols-outlined" aria-hidden>
          groups
        </span>
        Team
      </h1>
      <p className="mt-1 text-sm text-on-surface-variant">
        {canAssignManagerRoles(caller.role)
          ? "Add people, appoint managers, and assign a Regional Manager’s region."
          : "Add teachers and maintain the roster. Only the CPO or an administrator can appoint managers."}
      </p>
      <CreateAccountForm assignableRoles={rolesAssignableBy(caller.role)} />
      {error && (
        <p role="alert" className="mt-6 text-sm text-error">
          Couldn&rsquo;t load the team: {error.message}
        </p>
      )}
      <ul className="mt-6 flex flex-col gap-3">
        {(rows ?? []).map((row) => {
          const assignable = assignableFor(row as Row);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface-container p-4 shadow-sm"
            >
              <div>
                <p className="font-semibold text-on-surface">
                  {row.full_name}
                  {row.id === caller.id && (
                    <span className="ml-2 text-xs text-on-surface-variant">(you)</span>
                  )}
                  {row.archived_at && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2.5 py-0.5 text-xs font-semibold text-on-surface-variant">
                      Archived
                    </span>
                  )}
                  {row.clock_in_exempt && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-tertiary-container px-2.5 py-0.5 text-xs font-semibold text-on-tertiary-container">
                      Auto-attendance
                    </span>
                  )}
                </p>
                <p className="text-xs text-on-surface-variant">
                  {displayRole({ role: row.role as AppRole, job_title: row.job_title })}
                  {row.region
                    ? ` — ${REGION_LABELS[row.region as Region]}`
                    : ""}
                  {row.phone ? ` · ${row.phone}` : ""}
                </p>
              </div>
              {assignable && (
                <div className="flex flex-wrap items-center gap-2">
                  <RowForm
                    targetId={row.id}
                    currentRole={row.role as AppRole}
                    currentRegion={row.region as Region | null}
                    assignableRoles={assignable}
                  />
                  {row.role === "teacher" && (
                    <ClockInExemptButton
                      targetId={row.id}
                      exempt={Boolean(row.clock_in_exempt)}
                    />
                  )}
                  <ArchiveButton targetId={row.id} archived={row.archived_at != null} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
