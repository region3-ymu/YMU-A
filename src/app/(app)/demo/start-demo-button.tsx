"use client";

import { useActionState } from "react";
import { formatTime } from "@/lib/format/datetime";
import { startDemoShift, type DemoState } from "./actions";

export default function StartDemoButton({ teacherEmail }: { teacherEmail: string }) {
  const [state, action, pending] = useActionState<DemoState, FormData>(startDemoShift, undefined);
  const ready = state && "ready" in state;

  return (
    <div className="grid gap-3">
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 font-semibold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          <span className="material-symbols-outlined" aria-hidden>play_circle</span>
          {pending ? "Setting up…" : ready ? "Start a fresh demo class" : "Start demo class"}
        </button>
      </form>

      {state && "error" in state && (
        <p role="alert" className="rounded-lg bg-error-container p-3 text-sm text-on-error-container">
          {state.error}
        </p>
      )}

      {ready && (
        <div className="rounded-2xl bg-tertiary-container p-4 text-on-tertiary-container">
          <p className="flex items-center gap-2 font-bold">
            <span className="material-symbols-outlined" aria-hidden>check_circle</span>
            Demo class is live
          </p>
          <p className="mt-1 text-sm opacity-90">
            {formatTime(state.startedAt)} – {formatTime(state.endsAt)} at YMU Demo Site. It
            started five minutes ago, so the clock-in counts as on time.
          </p>
          <ol className="mt-3 grid list-decimal gap-1.5 pl-5 text-sm">
            <li>
              Sign in as <span className="font-semibold">{teacherEmail}</span> in another
              browser or a private window.
            </li>
            <li>Clocking → clock in. The GPS check passes from anywhere.</li>
            <li>Feedbacks → fill in the class feedback, or try &ldquo;Class canceled&rdquo;.</li>
            <li>Raise a ticket, then come back here as yourself to answer it.</li>
          </ol>
          {/* Pressing again is the documented way to redo it — worth saying,
              because clock_in() refuses a second session for the same class and
              a stuck demo mid-presentation is the worst time to discover that. */}
          <p className="mt-3 text-xs opacity-80">
            Press the button again to wipe this demo and start over — the previous demo
            class and its clock-in are removed.
          </p>
        </div>
      )}
    </div>
  );
}
