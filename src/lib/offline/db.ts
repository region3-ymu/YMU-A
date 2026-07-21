"use client";

import Dexie, { type EntityTable } from "dexie";

// IndexedDB for offline mode. Two concerns, both client-only:
//
//   queue          — mutations made while offline (clock-ins, GPS samples),
//                    each keyed by a client-generated UUID (client_key) that
//                    is the idempotency key end-to-end: the same key is what
//                    /api/sync upserts on, so replaying the queue can never
//                    create a duplicate. Rows live here until a sync confirms
//                    them (then deleted) or the server rejects them (kept,
//                    status 'rejected', so the teacher isn't silently dropped).
//   scheduleCache  — the next clockable class + its school coordinates,
//                    written whenever /clocking loads online, so the clock-in
//                    screen and its on-device geofence check still work with no
//                    connectivity. The service worker caches the app shell;
//                    this holds the structured data that shell needs.
//
// Kept in its own database, separate from ymu-a-feedback-drafts
// (offline-feedback-db.ts), so the two offline concerns evolve independently.

export type QueueKind = "clock_in" | "gps_check";

// pending  — waiting to sync (or a prior sync failed with a network error)
// syncing  — a sync run has picked it up (guards against a double-send)
// rejected — the server refused it on re-validation; kept for display, not resent
export type QueueStatus = "pending" | "syncing" | "rejected";

export type ClockInPayload = {
  event_id: string;
  school_id: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  // The real moment the teacher clocked in offline (ISO). The server trusts
  // this (clamped) so on_time/late reflects reality, not sync time.
  clock_in_at: string;
};

export type GpsCheckPayload = {
  // Which offline clock-in this sample belongs to — the session's client_key,
  // since the server-side check id doesn't exist offline.
  session_client_key: string;
  // Minutes after clock-in this check was due (5/10/15/20/25).
  due_offset_min: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  sampled_at: string;
};

export type QueueItem = {
  client_key: string;
  kind: QueueKind;
  payload: ClockInPayload | GpsCheckPayload;
  status: QueueStatus;
  created_at: string;
  attempts: number;
  last_error?: string;
};

// One row, key "next-class": the cached clockable class for offline rendering.
export type ScheduleCacheRow = {
  key: string;
  event_id: string;
  summary: string | null;
  start_at: string | null;
  end_at: string | null;
  school_id: string | null;
  school_name: string | null;
  school_lat: number | null;
  school_lng: number | null;
  school_radius_m: number | null;
  cached_at: string;
};

export const NEXT_CLASS_KEY = "next-class";

export const offlineDb = new Dexie("ymu-a-offline") as Dexie & {
  queue: EntityTable<QueueItem, "client_key">;
  scheduleCache: EntityTable<ScheduleCacheRow, "key">;
};

offlineDb.version(1).stores({
  // Indexed on status + kind so listPending()/countPending() don't scan.
  queue: "client_key, status, kind",
  scheduleCache: "key",
});
