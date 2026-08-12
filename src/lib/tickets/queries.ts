// Server reads for the ticket inbox.
//
// No role branching here on purpose: tickets_select (migration 0030) already
// scopes rows to "mine, or assigned to me, or my region, or everything if I'm
// an org-wide role". Re-implementing that in TypeScript would give two places
// to disagree, and the database is the one that decides.

import { createClient } from "@/lib/supabase/server";
import { OPEN_STATUSES, type TicketStatus } from "./status";

export {
  TICKET_STATUSES,
  STATUS_LABELS,
  OPEN_STATUSES,
  ROOT_CAUSES,
  type TicketStatus,
} from "./status";

export type TicketRow = {
  id: string;
  ticket_number: number;
  category_type: "Operational" | "Academic";
  issue_subcategory: string | null;
  priority_level: "Urgent" | "High" | "Normal";
  description: string;
  status: TicketStatus;
  root_cause_category: string | null;
  region: string | null;
  created_at: string;
  first_response_at: string | null;
  assigned_agent_id: string | null;
  teacher: { full_name: string; phone: string | null } | null;
  school: { name: string; address: string | null } | null;
  assigned_agent: { full_name: string } | null;
  // The class the ticket came out of, and what the teacher reported about it.
  // A manager reading a ticket needs the whole picture in one place; before
  // this they had the description and nothing else.
  event: { summary: string | null; start_at: string | null; end_at: string | null } | null;
  feedback: {
    engagement_level: string;
    quarter_goals_on_track: boolean;
    objectives_worked: string[];
    is_custom_program: boolean;
    custom_program_name: string | null;
    custom_notes: string | null;
    open_topic_note: string | null;
    submitted_at: string;
    program: { name: string } | null;
  } | null;
};

const TICKET_COLUMNS = `
  id, ticket_number, category_type, issue_subcategory, priority_level, description,
  status, root_cause_category, region, created_at, first_response_at, assigned_agent_id,
  teacher:profiles!tickets_teacher_id_fkey(full_name, phone),
  school:schools(name, address),
  assigned_agent:profiles!tickets_assigned_agent_id_fkey(full_name),
  event:calendar_events(summary, start_at, end_at),
  feedback:feedback_submissions!tickets_feedback_id_fkey(
    engagement_level, quarter_goals_on_track, objectives_worked,
    is_custom_program, custom_program_name, custom_notes,
    open_topic_note, submitted_at, program:programs(name)
  )
`;

export async function getTickets(opts: { onlyOpen?: boolean } = {}): Promise<TicketRow[]> {
  const supabase = await createClient();
  let query = supabase.from("tickets").select(TICKET_COLUMNS);
  if (opts.onlyOpen) query = query.in("status", OPEN_STATUSES);
  const { data } = await query
    // Urgent first, then oldest — an urgent ticket from this morning outranks
    // a normal one from last week, and within a priority the oldest has been
    // waiting longest.
    .order("priority_level", { ascending: true })
    .order("created_at", { ascending: true });
  return (data as unknown as TicketRow[]) ?? [];
}

export async function getTicket(id: string): Promise<TicketRow | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as TicketRow) ?? null;
}

export type TicketMessage = {
  id: string;
  sender_id: string | null;
  message_body: string;
  is_internal_note: boolean;
  created_at: string;
  sender: { full_name: string } | null;
};

export async function getTicketMessages(ticketId: string): Promise<TicketMessage[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ticket_messages")
    .select("id, sender_id, message_body, is_internal_note, created_at, sender:profiles(full_name)")
    // Internal notes are filtered by RLS, not here — a teacher's query simply
    // never returns them.
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  return (data as unknown as TicketMessage[]) ?? [];
}

/** Managers a ticket can be handed to. Teachers are excluded in SQL too. */
export async function getAssignableAgents(): Promise<{ id: string; full_name: string; role: string; region: string | null }[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role, region")
    .neq("role", "teacher")
    .is("archived_at", null)
    .order("full_name");
  return (data as { id: string; full_name: string; role: string; region: string | null }[]) ?? [];
}

export type TicketSla = {
  id: string;
  sla_state: import("./status").SlaState;
  unanswered_overdue: boolean;
  awaiting_response_minutes: number | null;
  open_active_minutes: number | null;
  frt_minutes: number | null;
  effective_ttr_minutes: number | null;
  paused_minutes: number;
  ttr_target_hours: number;
};

/**
 * SLA figures keyed by ticket id. Fetched alongside the ticket list rather
 * than joined into it because ticket_sla is a view over the same rows — the
 * two queries are scoped identically by RLS, and keeping them separate leaves
 * the list query readable.
 */
export async function getTicketSlaMap(): Promise<Map<string, TicketSla>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ticket_sla")
    .select(
      "id, sla_state, unanswered_overdue, awaiting_response_minutes, open_active_minutes, frt_minutes, effective_ttr_minutes, paused_minutes, ttr_target_hours",
    );
  return new Map(((data as unknown as TicketSla[]) ?? []).map((s) => [s.id, s]));
}

export type AgentMetrics = {
  open_total: number;
  open_urgent: number;
  open_warning: number;
  open_breached: number;
  unanswered: number;
  resolved_in_period: number;
  avg_frt_minutes: number | null;
  avg_effective_ttr_minutes: number | null;
  sla_compliance_pct: number | null;
  reopened_in_period: number;
  reopen_rate_pct: number | null;
};

export async function getAgentMetrics(days = 30): Promise<AgentMetrics | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("agent_ticket_metrics", { p_days: days });
  // The function returns a single row; PostgREST hands it back as an array.
  return ((data as AgentMetrics[]) ?? [])[0] ?? null;
}

export type WorkloadWeek = { week_start: string; opened: number; resolved: number };

export async function getWorkloadTrend(weeks = 8): Promise<WorkloadWeek[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("agent_workload_trend", { p_weeks: weeks });
  return (data as WorkloadWeek[]) ?? [];
}

export type RootCauseRow = {
  root_cause_category: string;
  category_type: string;
  tickets: number;
  avg_effective_ttr_minutes: number | null;
  schools_affected: number;
  teachers_affected: number;
};

export async function getRootCauseReport(from?: string, to?: string): Promise<RootCauseRow[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("root_cause_report", {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  return (data as RootCauseRow[]) ?? [];
}

/**
 * How many tickets are waiting on the caller, for the nav badge.
 *
 * A head-only count, so the badge costs a row count rather than the rows: it
 * renders on every page in the layout, and pulling full ticket bodies there
 * would tax every navigation for a number.
 */
export async function getActionableTicketCount(): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .in("status", OPEN_STATUSES);
  return count ?? 0;
}
