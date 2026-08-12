"use client";

import { useActionState, useMemo, useState } from "react";
import { submitClassFeedback, type ClassFeedbackState } from "./submit-actions";
import type { TopicRow } from "@/lib/feedback/queries";
import {
  ENGAGEMENT_OPTIONS,
  groupTopicsByPillar,
  ISSUE_SUBCATEGORIES,
  MIN_ISSUE_DESCRIPTION,
  PRIORITY_OPTIONS,
  type ProgramRow,
} from "@/lib/feedback/program-match";

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
  const [pillar, setPillar] = useState("");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [hasIssue, setHasIssue] = useState<"yes" | "no" | "">("");
  const [subcategory, setSubcategory] = useState("");
  const [description, setDescription] = useState("");

  const pillars = useMemo(() => groupTopicsByPillar(topics), [topics]);
  const hasChips = pillars.size > 0;

  const descriptionShort = hasIssue === "yes" && description.trim().length < MIN_ISSUE_DESCRIPTION;
  const canSubmit =
    !pending &&
    engagement !== "" &&
    onTrack !== "" &&
    hasIssue !== "" &&
    (hasIssue === "no" || (subcategory !== "" && !descriptionShort));

  function toggleTopic(id: string) {
    setTopicIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="session_id" value={sessionId} />
      <input type="hidden" name="program_id" value={program?.id ?? ""} />
      <input type="hidden" name="program_name" value={program?.name ?? className} />
      <input type="hidden" name="quarter_goals_on_track" value={onTrack} />
      <input type="hidden" name="has_issue" value={hasIssue} />
      <input type="hidden" name="engagement_level" value={engagement} />

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
              onSelect={() => setEngagement(option.value)}
              label={option.label}
              hint={option.hint}
            />
          ))}
        </div>
      </Section>

      <Section
        number={2}
        title="What did you work on?"
        hint={program ? `${program.name} — read from the class title.` : undefined}
      >
        {hasChips ? (
          <div className="grid gap-3">
            {Array.from(pillars.entries()).map(([pillarName, pillarTopics]) => (
              <div key={pillarName}>
                <button
                  type="button"
                  onClick={() => setPillar(pillar === pillarName ? "" : pillarName)}
                  className={`w-full rounded-xl px-3 py-3 text-left text-sm font-semibold transition ${
                    pillar === pillarName
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container-low text-on-surface"
                  }`}
                >
                  {pillarName}
                </button>
                {pillar === pillarName && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {pillarTopics.map((topic) => (
                      <button
                        key={topic.id}
                        type="button"
                        onClick={() => toggleTopic(topic.id)}
                        className={`rounded-full px-3 py-2 text-sm transition ${
                          topicIds.includes(topic.id)
                            ? "bg-tertiary text-on-tertiary"
                            : "bg-surface-container-highest text-on-surface-variant"
                        }`}
                      >
                        {topic.topic_name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-on-surface-variant">
              What did you work on? <span className="opacity-60">(optional)</span>
            </span>
            <textarea
              name="open_topic_note"
              rows={2}
              placeholder="Describe the piece, exercise or activity."
              className="w-full rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
            />
          </label>
        )}
        <input type="hidden" name="primary_focus_pillar" value={pillar} />
        {topicIds.map((id) => (
          <input key={id} type="hidden" name="topic_ids" value={id} />
        ))}
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
