"use client";

import { useActionState, useState } from "react";
import { deleteNewsPost } from "../actions";

// Two taps, no browser confirm(). A native dialog is easy to dismiss by reflex
// on a phone, and deleting an announcement takes its attachments with it.
export default function DeletePostButton({ postId }: { postId: string }) {
  const [state, action, pending] = useActionState(deleteNewsPost, undefined);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 rounded-full border-2 border-outline px-4 py-2 text-sm font-bold text-error"
      >
        <span className="material-symbols-outlined text-base" aria-hidden>delete</span>
        Delete
      </button>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="post_id" value={postId} />
      <span className="text-sm text-on-surface-variant">Delete this announcement and its files?</span>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-error px-4 py-2 text-sm font-bold text-on-error shadow-sm disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Yes, delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-full border-2 border-outline px-4 py-2 text-sm font-bold text-on-surface"
      >
        Keep it
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-sm text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
