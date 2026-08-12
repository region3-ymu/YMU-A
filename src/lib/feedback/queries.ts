// Server reads backing the native feedback form (PRD Module A).
//
// programs/program_topics are readable by every signed-in user (migration
// 0030) — the form is useless otherwise — so there is no role branching here.

import { createClient } from "@/lib/supabase/server";
import { matchProgram, type ProgramRow } from "./program-match";

export type TopicRow = {
  id: string;
  program_id: string;
  pillar_category: string;
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
    .select("id, program_id, pillar_category, topic_name")
    .eq("program_id", programId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  return (data as TopicRow[]) ?? [];
}

/**
 * Everything the form needs for one class: the full program list (so the
 * teacher can correct a wrong guess without a round trip), the guess itself,
 * and the chips for that guess.
 */
export async function getFeedbackFormData(summary: string | null | undefined) {
  const programs = await getPrograms();
  const guessed = matchProgram(summary, programs);
  const topics = await getTopicsForProgram(guessed?.id ?? null);
  return { programs, guessed, topics };
}
