"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

export type TicketActionState = { error?: string; ok?: boolean } | undefined;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Replying is a plain insert, not an RPC: ticket_messages_insert (0030) already
// enforces both rules that matter — you must be on the ticket, and only a
// manager may write an internal note.
export async function replyToTicket(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const profile = await requireProfile();

  const ticketId = String(formData.get("ticket_id") ?? "");
  const body = String(formData.get("message_body") ?? "").trim();
  const isInternal = String(formData.get("is_internal_note") ?? "") === "yes";

  if (!isUuid(ticketId)) return { error: "Ticket not found." };
  if (!body) return { error: "Write a message first." };

  const supabase = await createClient();
  const { error } = await supabase.from("ticket_messages").insert({
    ticket_id: ticketId,
    sender_id: profile.id,
    message_body: body,
    is_internal_note: isInternal,
  });
  if (error) return { error: error.message };

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  return { ok: true };
}

export async function changeTicketStatus(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  await requireProfile();

  const ticketId = String(formData.get("ticket_id") ?? "");
  const status = String(formData.get("status") ?? "");
  const rootCause = String(formData.get("root_cause_category") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!isUuid(ticketId)) return { error: "Ticket not found." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_ticket_status", {
    p_ticket_id: ticketId,
    p_status: status,
    p_root_cause_category: rootCause,
    p_note: note,
  });
  if (error) return { error: error.message };

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  return { ok: true };
}

export async function reassignTicket(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  await requireProfile();

  const ticketId = String(formData.get("ticket_id") ?? "");
  const agentId = String(formData.get("agent_id") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!isUuid(ticketId) || !isUuid(agentId)) return { error: "Choose someone to hand this to." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("reassign_ticket", {
    p_ticket_id: ticketId,
    p_new_agent_id: agentId,
    p_note: note,
  });
  if (error) return { error: error.message };

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  return { ok: true };
}
