"use client";

import { useEffect } from "react";
import { getDueChecks, getOwnOpenSessionId, recordGpsCheck } from "@/lib/gps-checks/actions";

// While the app is foregrounded and the teacher has an open session, this
// silently samples GPS for any gps_checks row that's come due (+5/10/15/20/25
// min after clock-in) — renders nothing, just background sampling per the
// "5 checks / 5 min, best-effort while foregrounded" plan decision. Locking
// the phone (visibilitychange -> hidden) simply stops the poll; any checks
// that were due but never sampled sit 'pending' until the check-closeout
// Edge Function marks them 'unverifiable' (no flag).
const POLL_INTERVAL_MS = 30_000;

async function sampleDueChecks() {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;

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
