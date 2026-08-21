"use client";

import { useActionState, useState } from "react";
import { ABSENCE_REASONS } from "@/lib/attendance/absence-reasons";
import { confirmSubstitution } from "./actions";
import type { Candidate, ConfirmResult, CoverableClass } from "./types";

const initialState: ConfirmResult = undefined;

/**
 * The step this module never had: turning a ranked candidate into a record.
 *
 * Two fields, and the second is the one YMU actually asked for — why the
 * assigned teacher is away. That answer has been going into free text on a
 * flag ("Confirmed DeAnthony as the substitute for this class"), where it
 * joins to nothing and cannot be counted.
 *
 * Which teacher is away has to be asked, not inferred: a co-taught class has
 * two matched attendees and Google records no primary/substitute distinction,
 * so on a two-teacher class the app genuinely does not know. It is a select
 * only when there is a choice to make.
 */
export default function ConfirmSubstitutionForm({
  klass,
  candidate,
}: {
  klass: CoverableClass;
  candidate: Candidate;
}) {
  const [state, formAction, pending] = useActionState(confirmSubstitution, initialState);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  // Exclude the candidate: covering yourself is a typo, and the SQL rejects it
  // with substitutions_not_self. Better not to offer it.
  const absentOptions = klass.assignedTeacherIds
    .map((id, index) => ({ id, name: klass.assignedTeachers[index] ?? "Unknown" }))
    .filter((teacher) => teacher.id !== candidate.teacher_id);

  const notesRequired = reason === "other";
  const blocked = !reason || (notesRequired && notes.trim() === "");

  if (state?.success) {
    return (
      <p className="mt-1 rounded-lg bg-tertiary-container p-2 text-xs text-on-tertiary-container">
        {state.success}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={absentOptions.length === 0}
        className="mt-1 justify-self-start rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
      >
        {absentOptions.length === 0 ? "Nobody to cover for" : "Confirm as substitute"}
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-1 grid gap-2 rounded-lg bg-surface-container-low p-3">
      <input type="hidden" name="event_id" value={klass.id} />
      <input type="hidden" name="substitute_teacher_id" value={candidate.teacher_id} />

      {absentOptions.length === 1 ? (
        <>
          <input type="hidden" name="absent_teacher_id" value={absentOptions[0].id} />
          <p className="text-xs text-on-surface-variant">
            Covering for{" "}
            <span className="font-semibold text-on-surface">{absentOptions[0].name}</span>
          </p>
        </>
      ) : (
        <label className="text-xs font-medium text-on-surface-variant">
          Who is away
          <select
            name="absent_teacher_id"
            required
            defaultValue=""
            className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="" disabled>
              Choose the teacher…
            </option>
            {absentOptions.map((teacher) => (
              <option key={teacher.id} value={teacher.id}>
                {teacher.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="text-xs font-medium text-on-surface-variant">
        Why they are away (required)
        <select
          name="reason"
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="" disabled>
            Choose a reason…
          </option>
          {ABSENCE_REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-on-surface-variant">
        {notesRequired ? "What happened (required)" : "Notes (optional)"}
        <textarea
          name="reason_notes"
          rows={2}
          required={notesRequired}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="mt-1 w-full rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || blocked}
          className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border-2 border-outline px-4 py-2 text-xs font-bold text-on-surface"
        >
          Cancel
        </button>
      </div>

      {/* Said before the manager commits, not after. Two of them will read this
          as "the app did it for me" otherwise, and the Google event is what
          feeds teacher_ids on the next sync — so an unedited event means the
          substitute never appears on the class and cannot clock in. */}
      <p className="text-xs text-on-surface-variant">
        This records the cover in YMU. You still need to change the attendee on the Google Calendar
        event — until you do, the substitute will not be able to clock in.
      </p>

      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
