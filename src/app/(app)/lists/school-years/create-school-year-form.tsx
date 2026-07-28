"use client";

import { useActionState } from "react";
import { createSchoolYear } from "./actions";

const INPUT_CLASSES =
  "rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary";

export default function CreateSchoolYearForm() {
  const [state, action, pending] = useActionState(createSchoolYear, undefined);

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-2xl bg-surface-container p-4 shadow-sm"
    >
      <h2 className="flex items-center gap-2 font-semibold text-on-surface">
        <span className="material-symbols-outlined text-primary" aria-hidden>
          calendar_month
        </span>
        Create a school year
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="text-sm font-medium text-on-surface">
            Name
          </label>
          <input
            id="name"
            name="name"
            required
            placeholder="2026-2027"
            className={INPUT_CLASSES}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="start_date" className="text-sm font-medium text-on-surface">
            Start date
          </label>
          <input id="start_date" name="start_date" type="date" required className={INPUT_CLASSES} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="end_date" className="text-sm font-medium text-on-surface">
            End date
          </label>
          <input id="end_date" name="end_date" type="date" required className={INPUT_CLASSES} />
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-2 self-start rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create school year"}
      </button>
      {state?.error && (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      )}
      {state?.success && <p className="text-sm text-tertiary">{state.success}</p>}
    </form>
  );
}
