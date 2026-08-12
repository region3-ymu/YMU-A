// Server reads backing the native feedback form (PRD Module A).
//
// programs/program_topics are readable by every signed-in user (migration
// 0030) — the form is useless otherwise — so there is no role branching here.

import { createClient } from "@/lib/supabase/server";
import { resolveProgram, type ProgramRow } from "./program-match";

export type TopicRow = {
  id: string;
  program_id: string;
  topic_name: string;
};

export async function getPrograms(): Promise<ProgramRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("programs")
    .select("id, name, category, match_patterns, sort_order")
    .eq("active", true)
    // Ascending sort_order IS the matching precedence — matchProgram takes the
    // first pattern that hits, so "Marching Band" must arrive before
    // "Beginning Band". Re-sorting this list anywhere downstream changes which
    // program a class resolves to.
    .order("sort_order", { ascending: true });
  return (data as ProgramRow[]) ?? [];
}

export async function getTopicsForProgram(programId: string | null): Promise<TopicRow[]> {
  if (!programId) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("program_topics")
    // pillar_category is deliberately not selected — the form shows one flat
    // list per program (spec, Aug 12) and the pillar names disagree across
    // programs. sort_order is the only ordering that survives.
    .select("id, program_id, topic_name")
    .eq("program_id", programId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  return (data as TopicRow[]) ?? [];
}

/**
 * Everything the form needs for one class. The program is resolved here and
 * never asked: the teacher sees which one it landed on, but does not pick it.
 * The full list is no longer returned — there is nothing left to pick from.
 */
export async function getFeedbackFormData(summary: string | null | undefined) {
  const programs = await getPrograms();
  const program = resolveProgram(summary, programs);
  const topics = await getTopicsForProgram(program?.id ?? null);
  return { program, topics };
}

export type SubmittedFeedback = {
  id: string;
  engagement_level: string;
  objectives_worked: string[];
  is_custom_program: boolean;
  custom_program_name: string | null;
  custom_notes: string | null;
  open_topic_note: string | null;
  quarter_goals_on_track: boolean;
  has_issue: boolean;
  submitted_at: string;
  program: { name: string } | null;
  school: { name: string } | null;
  event: { summary: string | null; start_at: string | null } | null;
};

/**
 * What the caller has already submitted, newest first.
 *
 * RLS scopes feedback_submissions to "mine, or my region if I'm a manager", so
 * this is a teacher's own history without any filter here. Capped: the point
 * is "what did I say about that class", not an archive to page through.
 */
export async function getSubmittedFeedback(limit = 25): Promise<SubmittedFeedback[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("feedback_submissions")
    .select(
      `id, engagement_level, objectives_worked, is_custom_program,
       custom_program_name, custom_notes, open_topic_note,
       quarter_goals_on_track, has_issue, submitted_at,
       program:programs(name), school:schools(name),
       event:calendar_events(summary, start_at)`,
    )
    .order("submitted_at", { ascending: false })
    .limit(limit);
  return (data as unknown as SubmittedFeedback[]) ?? [];
}
