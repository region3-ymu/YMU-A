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
  teacher_id: string;
  school_id: string | null;
  engagement_level: string;
  objectives_worked: string[];
  is_custom_program: boolean;
  custom_program_name: string | null;
  custom_notes: string | null;
  /** Only ever set when engagement_level is 'Canceled'. */
  cancellation_notes: string | null;
  open_topic_note: string | null;
  /** Null when the class was cancelled — there were no goals to be on track with. */
  quarter_goals_on_track: boolean | null;
  has_issue: boolean;
  submitted_at: string;
  program: { name: string } | null;
  school: { name: string } | null;
  event: { summary: string | null; start_at: string | null } | null;
};

const SUBMITTED_FEEDBACK_COLUMNS = `
  id, teacher_id, school_id, engagement_level, objectives_worked, is_custom_program,
  custom_program_name, custom_notes, cancellation_notes, open_topic_note,
  quarter_goals_on_track, has_issue, submitted_at,
  program:programs(name), school:schools(name),
  event:calendar_events(summary, start_at)
`;

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
    .select(SUBMITTED_FEEDBACK_COLUMNS)
    .order("submitted_at", { ascending: false })
    .limit(limit);
  return (data as unknown as SubmittedFeedback[]) ?? [];
}

export type FeedbackFilters = {
  teacherId?: string;
  schoolId?: string;
  /** Inclusive ISO date (YYYY-MM-DD), matched against submitted_at. */
  from?: string;
  /** Inclusive ISO date (YYYY-MM-DD), matched against submitted_at. */
  to?: string;
  engagement?: string;
  page?: number;
  pageSize?: number;
};

/**
 * The manager-facing feedback reader (/feedbacks).
 *
 * No role check and no region filter here on purpose: feedback_submissions_select
 * (0030) already gives a Regional Manager their own region's rows and CPO /
 * Operations Manager / Academic Manager every row. Re-implementing that in
 * TypeScript would be a second copy of the rule to keep in step, and the copy
 * that drifts is always the one outside the database.
 *
 * Returns `total` so the page can say "showing 25 of 340" rather than leaving
 * the reader guessing whether the list ended or the page did.
 */
export async function getFeedbackPage(
  filters: FeedbackFilters = {},
): Promise<{ rows: SubmittedFeedback[]; total: number; page: number; pageSize: number }> {
  const supabase = await createClient();
  const pageSize = filters.pageSize ?? 25;
  const page = Math.max(1, filters.page ?? 1);

  let query = supabase
    .from("feedback_submissions")
    .select(SUBMITTED_FEEDBACK_COLUMNS, { count: "exact" });

  if (filters.teacherId) query = query.eq("teacher_id", filters.teacherId);
  if (filters.schoolId) query = query.eq("school_id", filters.schoolId);
  if (filters.engagement) query = query.eq("engagement_level", filters.engagement);
  if (filters.from) query = query.gte("submitted_at", `${filters.from}T00:00:00Z`);
  // Exclusive upper bound on the NEXT day, so "to = today" includes everything
  // submitted today rather than only the midnight instant.
  if (filters.to) query = query.lt("submitted_at", `${nextDay(filters.to)}T00:00:00Z`);

  const { data, count } = await query
    .order("submitted_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  return {
    rows: (data as unknown as SubmittedFeedback[]) ?? [],
    total: count ?? 0,
    page,
    pageSize,
  };
}

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** One submission in full, for the detail view. Null when RLS hides it. */
export async function getFeedbackById(id: string): Promise<SubmittedFeedback | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("feedback_submissions")
    .select(SUBMITTED_FEEDBACK_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return (data as unknown as SubmittedFeedback) ?? null;
}

/**
 * The ticket a submission produced, if it produced one.
 *
 * Queried from the ticket side because that is where the foreign key lives
 * (tickets.feedback_id, added by 0037).
 */
export async function getTicketForFeedback(
  feedbackId: string,
): Promise<{ id: string; ticket_number: number; status: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tickets")
    .select("id, ticket_number, status")
    .eq("feedback_id", feedbackId)
    .maybeSingle();
  return (data as { id: string; ticket_number: number; status: string }) ?? null;
}
