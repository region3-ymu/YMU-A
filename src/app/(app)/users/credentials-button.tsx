"use client";

import { useActionState, useState } from "react";
import { sendPasswordResetLink, setTemporaryPassword } from "./actions";

// Somebody who cannot sign in used to be unfixable from inside the app: the
// only lever was /reset-password, whose mail does not arrive (ymu.org is
// unverified in Resend, so Supabase falls back to its own rate-limited sender).
//
// Two ways out, in the order they should be reached for:
//
//   1. A recovery link, generated and shown here for the admin to pass on by
//      whatever channel actually reaches the person. No email involved, and
//      nobody but them ever knows their password.
//   2. A temporary password, for when there is no way to get a link to them.
//
// Collapsed behind one button because on the common day nobody needs either.
const FIELD_CLASSES =
  "mt-1 w-full min-w-0 rounded-lg bg-surface-container px-3 py-1.5 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary";

export default function CredentialsButton({
  targetId,
  targetName,
}: {
  targetId: string;
  targetName: string;
}) {
  const [linkState, linkAction, linkPending] = useActionState(sendPasswordResetLink, undefined);
  const [pwState, pwAction, pwPending] = useActionState(setTemporaryPassword, undefined);
  const [open, setOpen] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [copied, setCopied] = useState(false);

  const link = linkState?.link;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-full border-2 border-outline px-3 py-1.5 text-xs font-bold text-on-surface transition-transform active:scale-[0.98]"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          key
        </span>
        Sign-in help
      </button>
    );
  }

  return (
    <div className="mt-2 grid min-w-0 gap-2 rounded-lg bg-surface-container-low p-3">
      <p className="text-xs font-medium text-on-surface-variant">
        Sign-in help for {targetName}
      </p>

      <form action={linkAction}>
        <input type="hidden" name="target_id" value={targetId} />
        <button
          type="submit"
          disabled={linkPending}
          className="w-full rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {linkPending ? "Generating…" : "Generate a recovery link"}
        </button>
      </form>

      {link && (
        <div className="grid min-w-0 gap-1.5 rounded-lg bg-surface-container p-2">
          <p className="text-xs text-on-surface-variant">
            Send this to them. It can only be used once.
          </p>
          {/* readOnly rather than a <p>: a one-line input is selectable and
              copyable on a phone, where triple-clicking a paragraph is not a
              gesture. break-all on the fallback below for the same reason the
              schedule detail page needed it — this is one very long token. */}
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full min-w-0 rounded bg-surface-container-high px-2 py-1.5 font-mono text-[11px] text-on-surface outline-none"
          />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                // Clipboard is blocked in some in-app browsers. The input above
                // is still selectable, so this failing is not a dead end.
                setCopied(false);
              }
            }}
            className="w-fit rounded-full border-2 border-outline px-3 py-1 text-xs font-bold text-on-surface"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {linkState?.error && (
        <p role="alert" className="break-words text-xs text-error">
          {linkState.error}
        </p>
      )}
      {linkState?.success && !link && (
        <p className="text-xs text-tertiary">{linkState.success}</p>
      )}

      {!showPasswordForm ? (
        <button
          type="button"
          onClick={() => setShowPasswordForm(true)}
          className="w-fit text-xs font-medium text-on-surface-variant underline"
        >
          Or set a temporary password
        </button>
      ) : (
        <form action={pwAction} className="grid min-w-0 gap-1.5">
          <input type="hidden" name="target_id" value={targetId} />
          <label className="text-xs font-medium text-on-surface-variant">
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
          <p className="text-xs text-on-surface-variant">
            You will know this password until they change it. Prefer the link above.
          </p>
          <button
            type="submit"
            disabled={pwPending}
            className="w-fit rounded-full border-2 border-outline px-4 py-1.5 text-xs font-bold text-on-surface disabled:opacity-50"
          >
            {pwPending ? "Saving…" : "Set password"}
          </button>
        </form>
      )}

      {pwState?.error && (
        <p role="alert" className="break-words text-xs text-error">
          {pwState.error}
        </p>
      )}
      {pwState?.success && <p className="text-xs text-tertiary">{pwState.success}</p>}

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-fit text-xs font-medium text-on-surface-variant underline"
      >
        Close
      </button>
    </div>
  );
}
