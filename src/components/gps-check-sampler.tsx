"use client";

import { useEffect } from "react";
import { getDueChecks, getOwnOpenSessionId, recordGpsCheck } from "@/lib/gps-checks/actions";
import { enqueueGpsCheck, listPendingClockIns } from "@/lib/offline/queue";

const CHECK_OFFSETS_MIN = [5, 10, 15, 20, 25];

// While the app is foregrounded and the teacher has an open session, this
// silently samples GPS for any gps_checks row that's come due (+5/10/15/20/25
// min after clock-in) — renders nothing, just background sampling per the
// "5 checks / 5 min, best-effort while foregrounded" plan decision. Locking
// the phone (visibilitychange -> hidden) simply stops the poll; any checks
// that were due but never sampled sit 'pending' until the check-closeout
// Edge Function marks them 'unverifiable' (no flag).
const POLL_INTERVAL_MS = 30_000;

// Offline path: an offline clock-in's gps_checks don't exist server-side yet
// (they're created when the clock-in itself syncs), so we can't reference a
// check id. Instead we walk the still-queued offline clock-ins, work out which
// +5/10/.../25 min offsets have come due, take one fix, and queue a GPS sample
// keyed by (session client_key, offset). enqueueGpsCheck dedupes per that key,
// so repeated polls don't pile up, and the server resolves it on sync via
// record_gps_check_offline. Same best-effort, foreground-only framing as the
// online sampler.
async function sampleOfflineDueChecks() {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;

  const clockIns = await listPendingClockIns();
  if (clockIns.length === 0) return;

  const now = Date.now();
  const due: { session_client_key: string; due_offset_min: number }[] = [];
  for (const ci of clockIns) {
    const clockInMs = Date.parse(ci.clock_in_at);
    if (Number.isNaN(clockInMs)) continue;
    for (const offset of CHECK_OFFSETS_MIN) {
      if (now >= clockInMs + offset * 60_000) {
        due.push({ session_client_key: ci.client_key, due_offset_min: offset });
      }
    }
  }
  if (due.length === 0) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const sampledAt = new Date().toISOString();
      for (const target of due) {
        await enqueueGpsCheck({
          ...target,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          sampled_at: sampledAt,
        });
      }
    },
    () => {
      // No fix — leave it; a later poll retries, or it closes out unverifiable.
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
  );
}

async function sampleDueChecks() {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;

  // Offline: sample against the queued offline clock-ins instead of the server.
  if (!navigator.onLine) {
    await sampleOfflineDueChecks();
    return;
  }

  const sessionId = await getOwnOpenSessionId();
  if (!sessionId) return;

  const due = await getDueChecks(sessionId);
  if (due.length === 0) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      for (const check of due) {
        await recordGpsCheck(
          check.id,
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy,
        );
      }
    },
    () => {
      // No fix available (denied/timeout/unavailable) — leave the checks
      // pending; they'll either get sampled on a later poll or closed out as
      // 'unverifiable' once overdue. Not surfaced to the teacher: sampling is
      // deliberately silent per the brief.
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
  );
}

export default function GpsCheckSampler() {
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (interval) return;
      sampleDueChecks();
      interval = setInterval(sampleDueChecks, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (interval) clearInterval(interval);
      interval = null;
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") startPolling();
      else stopPolling();
    }

    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
    };
  }, []);

  return null;
}
