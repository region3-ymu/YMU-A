"use client";

import { useActionState, useState } from "react";
import {
  REGIONS,
  REGION_LABELS,
  ROLE_LABELS,
  type AppRole,
  type Region,
} from "@/lib/auth/roles";
import { createAccount } from "./actions";

// Adding a person used to mean sending them to the signup page and then
// chasing them to confirm they had actually done it — /users could only
// re-role an account that already existed. This creates it outright.
//
// Collapsed behind a button rather than sitting open above the roster: the
// page's everyday job is reading and correcting the list, and a seven-field
// form permanently at the top pushes that below the fold.
const FIELD_CLASSES =
  "mt-1 w-full min-w-0 rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary";

export default function CreateAccountForm({
  assignableRoles,
}: {
  /** From the server: what this caller is allowed to hand out. */
  assignableRoles: AppRole[];
}) {
  const [state, action, pending] = useActionState(createAccount, undefined);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AppRole>("teacher");

  if (!open) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98]"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>
            person_add
          </span>
          Add someone
        </button>
        {state?.success && (
          <p className="mt-2 text-sm text-tertiary">{state.success}</p>
        )}
      </div>
    );
  }

  return (
    <form
      action={action}
      className="mt-4 grid min-w-0 gap-3 rounded-2xl bg-surface-container p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
        Add someone
      </h2>

      {/* One column on a phone, two from sm up. Every field min-w-0 — the role
          select holds the longest labels on the page and would otherwise set
          the width of the whole card. */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs font-medium text-on-surface-variant">
          Full name
          <input name="full_name" required autoComplete="off" className={FIELD_CLASSES} />
        </label>

        <label className="min-w-0 text-xs font-medium text-on-surface-variant">
          Email
          <input
            type="email"
            name="email"
            required
            autoComplete="off"
            placeholder="name@ymu.org"
            className={FIELD_CLASSES}
          />
        </label>

        <label className="min-w-0 text-xs font-medium text-on-surface-variant">
          Phone (optional)
          <input name="phone" autoComplete="off" className={FIELD_CLASSES} />
        </label>

        <label className="min-w-0 text-xs font-medium text-on-surface-variant">
          Role
          <select
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value as AppRole)}
            className={`${FIELD_CLASSES} truncate`}
          >
            {assignableRoles.map((assignable) => (
              <option key={assignable} value={assignable}>
                {ROLE_LABELS[assignable]}
              </option>
            ))}
          </select>
        </label>

        {/* Only the Regional Manager carries one. promote_user() nulls the
            column for every other role, so offering it would be a lie. */}
        {role === "regional_manager" && (
          <label className="min-w-0 text-xs font-medium text-on-surface-variant">
            Region
            <select name="region" required defaultValue="" className={`${FIELD_CLASSES} truncate`}>
              <option value="" disabled>
                Region…
              </option>
              {REGIONS.map((region: Region) => (
                <option key={region} value={region}>
                  {REGION_LABELS[region]}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="min-w-0 text-xs font-medium text-on-surface-variant">
          Temporary password
          <input
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={FIELD_CLASSES}
          />
        </label>
      </div>

      <p className="text-xs text-on-surface-variant">
        The account works immediately — no confirmation email. Pass the temporary
        password on, and they can change it in Settings.
      </p>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create account"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border-2 border-outline px-5 py-2.5 text-sm font-bold text-on-surface"
        >
          Cancel
        </button>
      </div>

      {state?.error && (
        <p role="alert" className="break-words text-sm text-error">
          {state.error}
        </p>
      )}
      {state?.success && <p className="text-sm text-tertiary">{state.success}</p>}
    </form>
  );
}
