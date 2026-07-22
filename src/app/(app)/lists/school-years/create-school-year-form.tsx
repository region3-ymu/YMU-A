"use client";

import { useActionState } from "react";
import { createSchoolYear } from "./actions";

const INPUT_CLASSES =
  "rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30";

export default function CreateSchoolYearForm() {
  const [state, action, pending] = useActionState(createSchoolYear, undefined);

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-2xl border border-foreground/10 p-4"
    >
      <h2 className="font-semibold">Create a school year</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="text-sm font-medium">
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
          <label htmlFor="start_date" className="text-sm font-medium">
            Start date
          </label>
          <input id="start_date" name="start_date" type="date" required className={INPUT_CLASSES} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="end_date" className="text-sm font-medium">
            End date
          </label>
          <input id="end_date" name="end_date" type="date" required className={INPUT_CLASSES} />
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create school year"}
      </button>
      {state?.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="text-sm text-green-700 dark:text-green-300">{state.success}</p>
      )}
    </form>
  );
}
