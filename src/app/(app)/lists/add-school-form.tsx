"use client";

import { useActionState } from "react";
import { addSchool } from "./actions";

const INPUT_CLASSES =
  "rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary";

export default function AddSchoolForm() {
  const [state, action, pending] = useActionState(addSchool, undefined);

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-2xl bg-surface-container p-4 shadow-sm"
    >
      <h2 className="flex items-center gap-2 font-semibold text-on-surface">
        <span className="material-symbols-outlined text-primary" aria-hidden>
          add
        </span>
        Add a school
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="text-sm font-medium text-on-surface">
            Name
          </label>
          <input id="name" name="name" required className={INPUT_CLASSES} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="address" className="text-sm font-medium text-on-surface">
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
          <label htmlFor="contact_name" className="text-sm font-medium text-on-surface">
            Contact name
          </label>
          <input id="contact_name" name="contact_name" className={INPUT_CLASSES} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="contact_phone" className="text-sm font-medium text-on-surface">
            Contact phone
          </label>
          <input id="contact_phone" name="contact_phone" className={INPUT_CLASSES} />
        </div>
      </div>
      <p className="text-xs text-on-surface-variant">
        The address is geocoded automatically (Census, then Nominatim) — you
        can correct the pin afterward if the match is off.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-2 self-start rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-50"
      >
        {pending ? "Geocoding…" : "Add school"}
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
