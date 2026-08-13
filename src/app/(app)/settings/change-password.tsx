"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { changePassword, type ChangePasswordState } from "./change-password-actions";

// Changing your own password without leaving Settings.
//
// This is the only way a teacher can change their password today: "Forgot
// password?" sends mail, and ymu.org has no SPF/DKIM/DMARC, so no provider
// will relay it. Until that is fixed, a login can otherwise only be reset by
// an admin.
//
// The current password is re-verified here rather than on the server, with a
// fresh signInWithPassword() — Supabase has no verify-only primitive, and the
// check needs the live email plus a password the user just typed. Same split
// AdminEditAttendanceForm has used since 0023.
export default function ChangePassword({ email }: { email: string }) {
  const [state, dispatch, pending] = useActionState<ChangePasswordState, FormData>(
    changePassword,
    undefined,
  );
  const [current, setCurrent] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError(null);

    if (!current) {
      setAuthError("Enter your current password.");
      return;
    }

    // Read the form BEFORE the await: React resets the element between the
    // event and the microtask, and currentTarget is null by the time an
    // awaited call returns.
    const data = new FormData(event.currentTarget);

    setVerifying(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password: current });
    setVerifying(false);

    if (error) {
      setAuthError("That is not your current password.");
      return;
    }

    setCurrent("");
    dispatch(data);
  }

  const busy = pending || verifying;

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 rounded-2xl bg-surface-container p-4 shadow-sm">
      {state?.ok && (
        <p className="rounded-lg bg-tertiary-container p-3 text-sm text-on-tertiary-container">
          Password changed. Use it next time you sign in.
        </p>
      )}
      {(state?.error || authError) && (
        <p role="alert" className="rounded-lg bg-error-container p-3 text-sm text-on-error-container">
          {authError ?? state?.error}
        </p>
      )}

      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">Current password</span>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">New password</span>
        <input
          type="password"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">Repeat new password</span>
        <input
          type="password"
          name="confirm"
          required
          minLength={8}
          autoComplete="new-password"
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <button
        type="submit"
        disabled={busy}
        className="mt-1 flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm transition disabled:opacity-50"
      >
        <span className="material-symbols-outlined text-base" aria-hidden>lock_reset</span>
        {verifying ? "Checking…" : pending ? "Saving…" : "Change password"}
      </button>
      <p className="text-xs text-on-surface-variant">
        At least 8 characters. You stay signed in on this device.
      </p>
    </form>
  );
}
