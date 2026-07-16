"use client";

import { useActionState, useState } from "react";
import {
  REGIONS,
  REGION_LABELS,
  ROLE_LABELS,
  type AppRole,
  type Region,
} from "@/lib/auth/roles";
import { promoteUser } from "./actions";

const SELECT_CLASSES =
  "rounded-lg border border-foreground/20 bg-background px-2 py-1.5 text-sm";

export default function RowForm({
  targetId,
  currentRole,
  currentRegion,
  assignableRoles,
}: {
  targetId: string;
  currentRole: AppRole;
  currentRegion: Region | null;
  assignableRoles: AppRole[];
}) {
  const [state, action, pending] = useActionState(promoteUser, undefined);
  const [role, setRole] = useState<AppRole>(currentRole);
  const unchanged = role === currentRole;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="target_id" value={targetId} />
      <select
        name="role"
        value={role}
        onChange={(event) => setRole(event.target.value as AppRole)}
        className={SELECT_CLASSES}
        aria-label="Role"
      >
        {assignableRoles.map((assignable) => (
          <option key={assignable} value={assignable}>
            {ROLE_LABELS[assignable]}
          </option>
        ))}
      </select>
      {role === "regional_manager" && (
        <select
          name="region"
          defaultValue={currentRegion ?? ""}
          required
          className={SELECT_CLASSES}
          aria-label="Region"
        >
          <option value="" disabled>
            Region…
          </option>
          {REGIONS.map((region) => (
            <option key={region} value={region}>
              {REGION_LABELS[region]}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        disabled={pending || (unchanged && role !== "regional_manager")}
        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground disabled:opacity-40"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="w-full text-xs text-green-700 dark:text-green-300">
          {state.success}
        </p>
      )}
    </form>
  );
}
