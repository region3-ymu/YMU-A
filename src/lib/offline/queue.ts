"use client";

import {
  NEXT_CLASS_KEY,
  offlineDb,
  type ClockInPayload,
  type GpsCheckPayload,
  type QueueItem,
  type ScheduleCacheRow,
} from "./db";

function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

// Fires whenever the queue changes, so the offline indicator can refresh its
// pending count without polling. Same-tab only; that's enough here since the
// UI and the queue live in the same tab.
const queueEvents = new EventTarget();

export function onQueueChanged(cb: () => void): () => void {
  const handler = () => cb();
  queueEvents.addEventListener("change", handler);
  return () => queueEvents.removeEventListener("change", handler);
}

function emitChange(): void {
  queueEvents.dispatchEvent(new Event("change"));
}

// Enqueue an offline clock-in. Returns its client_key, which doubles as the
// session's client_key server-side (so GPS samples for this session address it
// by the same key) and as the idempotency key for the sync upsert.
export async function enqueueClockIn(payload: ClockInPayload): Promise<string> {
  const client_key = uuid();
  await offlineDb.queue.put({
    client_key,
    kind: "clock_in",
    payload,
    status: "pending",
    created_at: nowIso(),
    attempts: 0,
  });
  emitChange();
  return client_key;
}

// Enqueue an offline GPS-check sample for an already-queued (or already-synced)
// offline clock-in, addressed by that clock-in's client_key + the check's due
// offset. Deduped per (session, offset): re-sampling the same due check just
// overwrites the pending queue row rather than piling up.
export async function enqueueGpsCheck(payload: GpsCheckPayload): Promise<void> {
  const existing = await offlineDb.queue
    .where("kind")
    .equals("gps_check")
    .filter(
      (item) =>
        (item.payload as GpsCheckPayload).session_client_key === payload.session_client_key &&
        (item.payload as GpsCheckPayload).due_offset_min === payload.due_offset_min &&
        item.status !== "rejected",
    )
    .first();
  if (existing) return;

  await offlineDb.queue.put({
    client_key: uuid(),
    kind: "gps_check",
    payload,
    status: "pending",
    created_at: nowIso(),
    attempts: 0,
  });
  emitChange();
}

// Items still to send. clock_in items come first so a GPS sample whose session
// is clocked in within the same batch resolves against the freshly-created row.
export async function listSendable(): Promise<QueueItem[]> {
  const items = await offlineDb.queue
    .where("status")
    .anyOf("pending", "syncing")
    .toArray();
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "clock_in" ? -1 : 1;
    return a.created_at.localeCompare(b.created_at);
  });
}

// Offline clock-ins not yet synced — the offline GPS sampler walks these to
// decide which +5/10/.../25 min checks have come due while still offline.
export async function listPendingClockIns(): Promise<
  { client_key: string; clock_in_at: string }[]
> {
  const items = await offlineDb.queue
    .where("kind")
    .equals("clock_in")
    .filter((i) => i.status !== "rejected")
    .toArray();
  return items.map((i) => ({
    client_key: i.client_key,
    clock_in_at: (i.payload as ClockInPayload).clock_in_at,
  }));
}

// Count of items not yet confirmed by the server — drives the pending-sync
// badge. Rejected items are excluded (they won't sync on their own).
export async function countPending(): Promise<number> {
  return offlineDb.queue.where("status").anyOf("pending", "syncing").count();
}

export async function markSyncing(clientKeys: string[]): Promise<void> {
  await offlineDb.queue.where("client_key").anyOf(clientKeys).modify({ status: "syncing" });
  emitChange();
}

export async function markPending(clientKey: string, error?: string): Promise<void> {
  const item = await offlineDb.queue.get(clientKey);
  if (!item) return;
  await offlineDb.queue.update(clientKey, {
    status: "pending",
    attempts: item.attempts + 1,
    last_error: error,
  });
  emitChange();
}

export async function markRejected(clientKey: string, error: string): Promise<void> {
  const item = await offlineDb.queue.get(clientKey);
  if (!item) return;
  await offlineDb.queue.update(clientKey, {
    status: "rejected",
    attempts: item.attempts + 1,
    last_error: error,
  });
  emitChange();
}

export async function removeItem(clientKey: string): Promise<void> {
  await offlineDb.queue.delete(clientKey);
  emitChange();
}

// ---------------------------------------------------------------------------
// Schedule cache — the next clockable class + school coords for offline use.
// ---------------------------------------------------------------------------

export async function cacheNextClass(row: Omit<ScheduleCacheRow, "key" | "cached_at">): Promise<void> {
  await offlineDb.scheduleCache.put({ ...row, key: NEXT_CLASS_KEY, cached_at: nowIso() });
}

export async function getCachedNextClass(): Promise<ScheduleCacheRow | null> {
  return (await offlineDb.scheduleCache.get(NEXT_CLASS_KEY)) ?? null;
}
