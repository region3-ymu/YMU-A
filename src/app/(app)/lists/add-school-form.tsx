"use client";

import { useActionState } from "react";
import { addSchool } from "./actions";

const INPUT_CLASSES =
  "rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30";

export default function AddSchoolForm() {
  const [state, action, pending] = useActionState(addSchool, undefined);

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-2xl border border-foreground/10 p-4"
    >
      <h2 className="font-semibold">Add a school</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input id="name" name="name" required className={INPUT_CLASSES} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="address" className="text-sm font-medium">
            Address
          </label>
          <input
            id="address"
            name="address"
            required
            placeholder="1234 SW 8th St, Miami, FL 33135"
            className={INPUT_CLASSES}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="contact_name" className="text-sm font-medium">
            Contact name
          </label>
          <input id="contact_name" name="contact_name" className={INPUT_CLASSES} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="contact_phone" className="text-sm font-medium">
            Contact phone
          </label>
          <input id="contact_phone" name="contact_phone" className={INPUT_CLASSES} />
        </div>
      </div>
      <p className="text-xs opacity-60">
        The address is geocoded automatically (Census, then Nominatim) — you
        can correct the pin afterward if the match is off.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50"
      >
        {pending ? "Geocoding…" : "Add school"}
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
