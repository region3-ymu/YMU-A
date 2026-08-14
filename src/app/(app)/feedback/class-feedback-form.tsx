"use client";

import { useActionState, useState } from "react";
import { submitClassFeedback, type ClassFeedbackState } from "./submit-actions";
import type { TopicRow } from "@/lib/feedback/queries";
import {
  CANCELLED_ENGAGEMENT,
  ENGAGEMENT_OPTIONS,
  ISSUE_SUBCATEGORIES,
  MIN_ISSUE_DESCRIPTION,
  PRIORITY_OPTIONS,
  type ProgramRow,
} from "@/lib/feedback/program-match";
import {
  buildObjectivePayload,
  describeObjectiveGap,
  objectiveHeading,
  type ObjectiveSelection,
} from "@/lib/feedback/objectives";

// PRD Module A: the four-section daily form, targeting under 45 seconds on a
// phone. Teacher, school, date and class are never asked — the app already
// knows them from the session, and re-asking is most of what made the old
// form slow.
//
// Everything is one screen rather than a wizard. Four taps beat four screens,
// and a teacher packing up between classes should never wonder how many steps
// are left.
export default function ClassFeedbackForm({
  sessionId,
  className,
  schoolName,
  program,
  topics,
}: {
  sessionId: string;
  className: string;
  schoolName: string | null;
  /** Resolved from the calendar title — shown, never chosen (YMU 2026-08-12). */
  program: ProgramRow | null;
  topics: TopicRow[];
}) {
  const [state, action, pending] = useActionState<ClassFeedbackState, FormData>(
    submitClassFeedback,
    undefined,
  );

  const [engagement, setEngagement] = useState("");
  const [onTrack, setOnTrack] = useState<"yes" | "no" | "">("");
  const [hasIssue, setHasIssue] = useState<"yes" | "no" | "">("");
  const [subcategory, setSubcategory] = useState("");
  const [description, setDescription] = useState("");
  const [cancellationNotes, setCancellationNotes] = useState("");

  // Section 2's whole state in one object, so the two halves can only ever be
  // replaced together — see toggleCustomProgram.
  const [selection, setSelection] = useState<ObjectiveSelection>({
    isCustom: false,
    objectives: [],
    customProgramName: "",
    customNotes: "",
  });

  // Cancellation spec §3: a class that did not happen has no objectives, no
  // quarter-goal progress and no issue to report, so Sections 2-4 come off the
  // screen entirely rather than being disabled.
  const cancelled = engagement === CANCELLED_ENGAGEMENT;

  const offersObjectives = topics.length > 0;
  const objectivePayload = buildObjectivePayload(selection);
  const objectiveGap = describeObjectiveGap(selection, { offersObjectives });

  const descriptionShort = hasIssue === "yes" && description.trim().length < MIN_ISSUE_DESCRIPTION;
  const canSubmit = cancelled
    // Nothing beyond the engagement choice itself: the notes are optional.
    ? !pending
    : !pending &&
      engagement !== "" &&
      onTrack !== "" &&
      objectiveGap === null &&
      hasIssue !== "" &&
      (hasIssue === "no" || (subcategory !== "" && !descriptionShort));

  // Cancellation spec §6, the client half: switching into "Class canceled"
  // clears the answers that no longer apply, and switching back out clears the
  // notes. Neither direction may leave stale data behind for a hidden input to
  // post. feedback_cancelled_shape (0046) enforces the same rule in the DB for
  // anything that bypasses this form.
  function chooseEngagement(value: string) {
    setEngagement(value);
    if (value === CANCELLED_ENGAGEMENT) {
      setOnTrack("");
      setHasIssue("");
      setSubcategory("");
      setDescription("");
      setSelection({ isCustom: false, objectives: [], customProgramName: "", customNotes: "" });
    } else {
      setCancellationNotes("");
    }
  }

  function toggleObjective(name: string) {
    setSelection((prev) => ({
      ...prev,
      objectives: prev.objectives.includes(name)
        ? prev.objectives.filter((o) => o !== name)
        : [...prev.objectives, name],
    }));
  }

  // Switching between the detected program and a hand-named one resets BOTH
  // halves rather than hiding one of them. Spec §5: a program change must
  // never leave the previous program's answers behind to be submitted, and
  // objectives ticked for Drumline mean nothing under "Steel Drum Club".
  function toggleCustomProgram() {
    setSelection((prev) => ({
      isCustom: !prev.isCustom,
      objectives: [],
      customProgramName: "",
      customNotes: "",
    }));
  }

  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="session_id" value={sessionId} />
      <input type="hidden" name="engagement_level" value={engagement} />
      {/* Same principle as Section 2's two halves below: only the inputs that
          still apply are mounted, so the rest are absent from the POST rather
          than merely blank. */}
      {!cancelled && (
        <>
          <input type="hidden" name="program_id" value={program?.id ?? ""} />
          <input type="hidden" name="program_name" value={program?.name ?? className} />
          <input type="hidden" name="quarter_goals_on_track" value={onTrack} />
          <input type="hidden" name="has_issue" value={hasIssue} />
        </>
      )}

      <Section
        number={1}
        title="How did students engage today?"
        hint="One tap — this is the daily pulse."
      >
        <div className="grid gap-2">
          {ENGAGEMENT_OPTIONS.map((option) => (
            <Choice
              key={option.value}
              selected={engagement === option.value}
              onSelect={() => chooseEngagement(option.value)}
              label={option.label}
              hint={option.hint}
              tone={option.value === CANCELLED_ENGAGEMENT ? "warning" : "primary"}
            />
          ))}
        </div>
      </Section>

      {cancelled && (
        <Section number={2} title="Anything worth noting?" hint="Optional — submit without it if you like.">
          <textarea
            name="cancellation_notes"
            rows={3}
            value={cancellationNotes}
            onChange={(e) => setCancellationNotes(e.target.value)}
            placeholder="Add any notes about the cancellation — optional."
            className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          />
          <p className="mt-2 text-xs text-on-surface-variant">
            Submitting opens a ticket for your Regional Manager automatically — no extra form.
          </p>
        </Section>
      )}

      {!cancelled && (
        <>
          <Section
            number={2}
            title={objectiveHeading(selection.isCustom ? null : program?.name)}
            hint="Tick every objective the class actually covered."
          >
            {/* The program is detected from the calendar title and shown, never
                chosen (YMU 2026-08-12). Which makes saying so out loud part of the
                control: if the detection is wrong, this line is the only place a
                teacher can notice before the data is. */}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-base" aria-hidden>event_note</span>
              <span>
                Program:{" "}
                <span className="font-semibold text-on-surface">
                  {selection.isCustom ? "you're naming it below" : (program?.name ?? className)}
                </span>
              </span>
              <button
                type="button"
                onClick={toggleCustomProgram}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {selection.isCustom ? "Use the detected program" : "Not this one?"}
              </button>
            </p>

            {selection.isCustom ? (
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-on-surface-variant">What program was it?</span>
                  <input
                    type="text"
                    value={selection.customProgramName}
                    onChange={(e) =>
                      setSelection((prev) => ({ ...prev, customProgramName: e.target.value }))
                    }
                    placeholder="e.g. Steel Drum Club"
                    className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-on-surface-variant">What did you work on?</span>
                  <textarea
                    rows={3}
                    value={selection.customNotes}
                    onChange={(e) => setSelection((prev) => ({ ...prev, customNotes: e.target.value }))}
                    placeholder="Describe the objective of today's class."
                    className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                  />
                </label>
              </div>
            ) : offersObjectives ? (
              <div className="mt-3 grid gap-1.5">
                {topics.map((topic) => {
                  const checked = selection.objectives.includes(topic.topic_name);
                  return (
                    <label
                      key={topic.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                        checked
                          ? "bg-tertiary-container text-on-tertiary-container"
                          : "bg-surface-container-low text-on-surface"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleObjective(topic.topic_name)}
                        className="mt-0.5 size-4 shrink-0 accent-current"
                      />
                      <span>{topic.topic_name}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              // A program whose objectives have not been loaded yet must not lock
              // its teachers out of submitting at all.
              <p className="mt-3 rounded-lg bg-surface-container-low p-3 text-sm text-on-surface-variant">
                This program has no objectives loaded yet. Use “Not this one?” above to describe the
                class in your own words.
              </p>
            )}

            {/* Guidance, not an error: this is why Submit is still greyed out, and
                a teacher should not have to press it to find out. */}
            {objectiveGap && <p className="mt-2 text-xs text-on-surface-variant">{objectiveGap}</p>}

            {/* Only the chosen half is ever mounted, so the other half is not
                merely cleared — it is not in the POST at all. */}
            <input
              type="hidden"
              name="is_custom_program"
              value={objectivePayload.is_custom_program ? "yes" : "no"}
            />
            {objectivePayload.is_custom_program ? (
              <>
                <input
                  type="hidden"
                  name="custom_program_name"
                  value={objectivePayload.custom_program_name ?? ""}
                />
                <input type="hidden" name="custom_notes" value={objectivePayload.custom_notes ?? ""} />
              </>
            ) : (
              objectivePayload.objectives_worked.map((name) => (
                <input key={name} type="hidden" name="objectives_worked" value={name} />
              ))
            )}
          </Section>

          <Section
            number={3}
            title="On track with quarter and concert goals?"
            hint="Answering “no” opens a ticket for your Regional Manager automatically."
          >
            <div className="grid gap-2">
              <Choice selected={onTrack === "yes"} onSelect={() => setOnTrack("yes")} label="Yes, on track" />
              <Choice
                selected={onTrack === "no"}
                onSelect={() => setOnTrack("no")}
                label="No, falling behind"
                hint="We'll raise it for you — no extra form."
                tone="warning"
              />
            </div>
          </Section>

          <Section number={4} title="Any issues or support needed?">
            <div className="grid gap-2">
              <Choice selected={hasIssue === "no"} onSelect={() => setHasIssue("no")} label="No issues today" />
              <Choice
                selected={hasIssue === "yes"}
                onSelect={() => setHasIssue("yes")}
                label="Yes, I need support"
                tone="warning"
              />
            </div>

            {hasIssue === "yes" && (
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-on-surface-variant">What kind?</span>
                  <select
                    name="issue_subcategory"
                    value={subcategory}
                    onChange={(e) => setSubcategory(e.target.value)}
                    className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">Choose…</option>
                    {ISSUE_SUBCATEGORIES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-on-surface-variant">How urgent?</span>
                  <select
                    name="priority_level"
                    defaultValue="Normal"
                    className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                  >
                    {PRIORITY_OPTIONS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label} — {p.hint}</option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-on-surface-variant">What happened?</span>
                  <textarea
                    name="issue_description"
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Enough detail that your manager can act without calling you first."
                    className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
                  />
                  <span className={`text-xs ${descriptionShort ? "text-error" : "text-on-surface-variant"}`}>
                    {descriptionShort
                      ? `${MIN_ISSUE_DESCRIPTION - description.trim().length} more characters needed`
                      : `${description.trim().length} characters`}
                  </span>
                </label>
              </div>
            )}
          </Section>
        </>
      )}

      {state?.error && (
        <p className="rounded-lg bg-error-container p-3 text-sm text-on-error-container">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 font-semibold text-on-primary shadow-sm transition disabled:opacity-50"
      >
        <span className="material-symbols-outlined" aria-hidden>check_circle</span>
        {pending ? "Submitting…" : "Submit feedback"}
      </button>
      <p className="-mt-3 text-center text-xs text-on-surface-variant">
        {schoolName ? `${className} · ${schoolName}` : className}
      </p>
    </form>
  );
}

function Section({
  number,
  title,
  hint,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-surface-container p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step {number}</p>
      <h2 className="mt-0.5 font-semibold text-on-surface">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-on-surface-variant">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Choice({
  selected,
  onSelect,
  label,
  hint,
  tone = "primary",
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  tone?: "primary" | "warning";
}) {
  const activeClass =
    tone === "warning" ? "bg-warning-container text-on-warning-container" : "bg-primary text-on-primary";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-xl px-4 py-3 text-left transition ${
        selected ? activeClass : "bg-surface-container-low text-on-surface"
      }`}
    >
      <span className="block text-sm font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-xs opacity-80">{hint}</span>}
    </button>
  );
}
