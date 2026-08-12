"use client";

import { useActionState, useState } from "react";
import {
  changeTicketStatus,
  reassignTicket,
  replyToTicket,
  type TicketActionState,
} from "../actions";
import { ROOT_CAUSES, STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@/lib/tickets/status";

export function ReplyBox({ ticketId, canWriteNote }: { ticketId: string; canWriteNote: boolean }) {
  const [state, action, pending] = useActionState<TicketActionState, FormData>(replyToTicket, undefined);
  const [internal, setInternal] = useState(false);

  return (
    <form action={action} className="grid min-w-0 gap-2">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <input type="hidden" name="is_internal_note" value={internal ? "yes" : "no"} />
      <textarea
        name="message_body"
        rows={3}
        required
        placeholder={internal ? "Internal note — the teacher never sees this." : "Reply to the teacher…"}
        className="w-full min-w-0 rounded-lg bg-surface-container-low px-3 py-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
      />
      <div className="flex items-center justify-between gap-3">
        {canWriteNote ? (
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="size-4 accent-[var(--primary)]"
            />
            Internal note
          </label>
        ) : (
          <span />
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-primary px-5 py-2 text-sm font-bold text-on-primary disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
      {state?.error && (
        <p className="rounded-lg bg-error-container p-2 text-sm text-on-error-container">{state.error}</p>
      )}
    </form>
  );
}

export function StatusControl({
  ticketId,
  current,
  currentRootCause,
}: {
  ticketId: string;
  current: TicketStatus;
  currentRootCause: string | null;
}) {
  const [state, action, pending] = useActionState<TicketActionState, FormData>(
    changeTicketStatus,
    undefined,
  );
  const [status, setStatus] = useState<TicketStatus>(current);

  // The root-cause picker appears only when it is about to be required, so the
  // common transitions stay one tap.
  const needsRootCause = status === "Resolved" && !currentRootCause;

  return (
    <form action={action} className="grid min-w-0 gap-2">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">Status</span>
        <select
          name="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as TicketStatus)}
          className="w-full min-w-0 rounded-lg bg-surface-container-low px-3 py-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
      </label>

      {needsRootCause && (
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-on-surface-variant">Root cause (required to resolve)</span>
          <select
            name="root_cause_category"
            required
            defaultValue=""
            className="w-full min-w-0 rounded-lg bg-surface-container-low px-3 py-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="" disabled>Choose…</option>
            {ROOT_CAUSES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>
      )}

      <button
        type="submit"
        disabled={pending || status === current}
        className="rounded-full border-2 border-outline px-5 py-2 text-sm font-bold text-on-surface disabled:opacity-50"
      >
        {pending ? "Updating…" : "Update status"}
      </button>
      {state?.error && (
        <p className="rounded-lg bg-error-container p-2 text-sm text-on-error-container">{state.error}</p>
      )}
    </form>
  );
}

export function ReassignControl({
  ticketId,
  currentAgentId,
  agents,
}: {
  ticketId: string;
  currentAgentId: string | null;
  agents: { id: string; full_name: string; role: string; region: string | null }[];
}) {
  const [state, action, pending] = useActionState<TicketActionState, FormData>(reassignTicket, undefined);
  const [agentId, setAgentId] = useState(currentAgentId ?? "");

  return (
    <form action={action} className="grid min-w-0 gap-2">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">Owner</span>
        <select
          name="agent_id"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full min-w-0 rounded-lg bg-surface-container-low px-3 py-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="" disabled>Choose…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name}
              {a.region ? ` — ${a.region}` : ""}
            </option>
          ))}
        </select>
      </label>
      <input
        name="note"
        placeholder="Why are you handing it over? (optional)"
        className="w-full min-w-0 rounded-lg bg-surface-container-low px-3 py-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
      />
      <button
        type="submit"
        disabled={pending || agentId === "" || agentId === currentAgentId}
        className="rounded-full border-2 border-outline px-5 py-2 text-sm font-bold text-on-surface disabled:opacity-50"
      >
        {pending ? "Reassigning…" : "Reassign"}
      </button>
      {state?.error && (
        <p className="rounded-lg bg-error-container p-2 text-sm text-on-error-container">{state.error}</p>
      )}
    </form>
  );
}
