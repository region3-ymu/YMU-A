"use client";

import { useActionState, useState } from "react";
import { submitRelayFeedback, type RelayFeedbackState } from "./actions";
import {
  ACHIEVED_OBJECTIVE_OPTIONS,
  CHALLENGE_OPTIONS,
  ENGAGEMENT_SCALE_MAX_LABEL,
  ENGAGEMENT_SCALE_MIN_LABEL,
  ENGAGEMENT_SCALE_VALUES,
  PROGRAM_AREAS,
  RELAY_BLOCKS,
} from "@/lib/attendance/relay-feedback";

// This week's PD self-reflection form, filled directly in the app (no
// external Google Form, no relay) — see supabase/migrations/0022. Faithfully
// mirrors the real reference form's questions except "Teacher Name"/"Day of
// Session", which the app already knows and doesn't re-ask.
export default function RelayFeedbackForm({ sessionId }: { sessionId: string }) {
  const [state, action, pending] = useActionState<RelayFeedbackState, FormData>(submitRelayFeedback, undefined);
  const [challenges, setChallenges] = useState<string[]>([]);

  function toggleChallenge(option: string) {
    setChallenges((prev) => (prev.includes(option) ? prev.filter((c) => c !== option) : [...prev, option]));
  }

  return (
    <form action={action} className="mt-4 grid gap-4">
      <input type="hidden" name="session_id" value={sessionId} />

      <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Section 1: Session Information</p>

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          Relay Block <span className="opacity-60">(required)</span>
        </span>
        <select
          name="relay_block"
          required
          defaultValue=""
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="" disabled>
            Choose…
          </option>
          {RELAY_BLOCKS.map((block) => (
            <option key={block} value={block}>
              {block}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          Program Area <span className="opacity-60">(required)</span>
        </span>
        <select
          name="program_area"
          required
          defaultValue=""
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="" disabled>
            Choose…
          </option>
          {PROGRAM_AREAS.map((area) => (
            <option key={area} value={area}>
              {area}
            </option>
          ))}
        </select>
      </label>

      <p className="mt-2 text-xs font-semibold uppercase tracking-wide opacity-60">
        Section 2: Lesson Objective &amp; Execution
      </p>

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          What was your main objective/focus for this 20-min lesson? <span className="opacity-60">(required)</span>
        </span>
        <input
          type="text"
          name="objective"
          required
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <fieldset>
        <legend className="text-sm font-medium">
          Did you achieve your primary objective? <span className="opacity-60">(required)</span>
        </legend>
        <div className="mt-2 grid gap-1.5">
          {ACHIEVED_OBJECTIVE_OPTIONS.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input type="radio" name="achieved_objective" value={option} required />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          Objective Reflection (Why or why not?) <span className="opacity-60">(required)</span>
        </span>
        <textarea
          name="objective_reflection"
          required
          rows={3}
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <p className="mt-2 text-xs font-semibold uppercase tracking-wide opacity-60">
        Section 3: Engagement &amp; Reflection
      </p>

      <fieldset>
        <legend className="text-sm font-medium">
          How engaged were your students during the relay? <span className="opacity-60">(required)</span>
        </legend>
        <div className="mt-2 flex items-center justify-between gap-2">
          {ENGAGEMENT_SCALE_VALUES.map((value) => (
            <label key={value} className="flex flex-col items-center gap-1 text-xs">
              <input type="radio" name="engagement_scale" value={value} required />
              {value}
            </label>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs opacity-60">
          <span>{ENGAGEMENT_SCALE_MIN_LABEL}</span>
          <span>{ENGAGEMENT_SCALE_MAX_LABEL}</span>
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">
          What was the biggest challenge or issue during this session?{" "}
          <span className="opacity-60">(required — select all that apply)</span>
        </legend>
        <div className="mt-2 grid gap-1.5">
          {CHALLENGE_OPTIONS.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="challenges"
                value={option}
                checked={challenges.includes(option)}
                onChange={() => toggleChallenge(option)}
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          Reflection &amp; Pivots (How did you handle any challenges or what would you adjust next time?){" "}
          <span className="opacity-60">(optional)</span>
        </span>
        <textarea
          name="pivots"
          rows={3}
          className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <button
        type="submit"
        disabled={pending || challenges.length === 0}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-on-primary shadow-md transition-transform active:scale-[0.98] disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Submit feedback"}
        {!pending && (
          <span className="material-symbols-outlined text-xl" aria-hidden>
            check
          </span>
        )}
      </button>
      {challenges.length === 0 && (
        <p className="-mt-2 text-xs text-on-surface-variant">Select at least one challenge option above to submit.</p>
      )}
      {state?.error && (
        <p role="alert" className="text-sm font-medium text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
