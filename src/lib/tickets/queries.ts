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
  school: { name: string } | null;
  assigned_agent: { full_name: string } | null;
};

const TICKET_COLUMNS = `
  id, ticket_number, category_type, issue_subcategory, priority_level, description,
  status, root_cause_category, region, created_at, first_response_at, assigned_agent_id,
  teacher:profiles!tickets_teacher_id_fkey(full_name, phone),
  school:schools(name),
  assigned_agent:profiles!tickets_assigned_agent_id_fkey(full_name)
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
