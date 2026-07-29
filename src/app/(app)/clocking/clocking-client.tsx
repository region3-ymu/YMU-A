"use client";

import dynamic from "next/dynamic";
import { useActionState, useEffect, useState } from "react";
import { haversineMeters } from "@/lib/geo/haversine";
import {
  STATUS_LABELS,
  computeClockInStatus,
  minutesLate,
} from "@/lib/attendance/status";
import { cacheNextClass, enqueueClockIn } from "@/lib/offline/queue";
import { syncNow } from "@/lib/offline/sync";
import { clockIn, type ClockInState } from "./actions";

// Leaflet touches window at import time, so the map is client-only. ssr:false
// is only valid from a Client Component (see Next.js lazy-loading guide).
const GeoMap = dynamic(() => import("@/components/geo-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs opacity-60">Loading map…</div>
  ),
});

// A fix accurate only to worse than this can't confirm you're inside a 200 m
// fence, so it's treated as its own error state with a retry, per the brief.
const LOW_ACCURACY_THRESHOLD_M = 100;

type GeoErrorKind = "unsupported" | "denied" | "unavailable" | "timeout";

// Mirrors src/lib/push.ts / install-prompt.tsx: iPadOS 13+ reports as
// "MacIntel" but with touch support, unlike a real Mac.
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

type ClockSchool = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radiusM: number;
};

type Position = { lat: number; lng: number; accuracy: number };

const initialState: ClockInState = undefined;

function describeGeoError(kind: GeoErrorKind): { title: string; detail: string } {
  switch (kind) {
    case "denied":
      return {
        title: "Location permission denied",
        detail: isIOS()
          ? "First check Settings → Privacy & Security → Location Services is ON. If it is and this still fails, an installed iPhone app can't re-ask for location and shows no location toggle in Settings — delete YMU-A from your Home Screen, reopen ymu-a-navy.vercel.app in Safari, tap Allow when it asks for location, then re-add it via Share → Add to Home Screen."
          : "Clocking in needs your location to confirm you're at the school. Enable location for this site in your browser settings, then try again.",
      };
    case "unavailable":
      return {
        title: "Location unavailable",
        detail:
          "Your device couldn't get a GPS fix — check that Location Services are turned on, then try again.",
      };
    case "timeout":
      return {
        title: "Location timed out",
        detail: "Getting your location took too long. Move somewhere with a clearer signal and try again.",
      };
    case "unsupported":
      return {
        title: "Location not supported",
        detail: "This device or browser can't share a location, so clock-in can't verify you're at the school.",
      };
  }
}

export default function ClockingClient({
  eventId,
  className,
  startAt,
  school,
}: {
  eventId: string;
  className: string;
  startAt: string | null;
  school: ClockSchool;
}) {
  const [position, setPosition] = useState<Position | null>(null);
  const [geoError, setGeoError] = useState<GeoErrorKind | null>(null);
  const [locating, setLocating] = useState(false);
  const [clientKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(clockIn, initialState);

  // navigator.onLine can't be read during SSR, so assume online for the first
  // render (matching the server) and sync the real value in an effect — same
  // hydration-safe pattern as feedback-form.tsx / offline-indicator.tsx.
  const [online, setOnline] = useState(true);
  const [offlineSaved, setOfflineSaved] = useState(false);
  const [savingOffline, setSavingOffline] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- navigator.onLine is unreadable during SSR.
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Cache this clockable class + its school coordinates while online, so the
  // on-device geofence check still works if connectivity drops on this screen.
  useEffect(() => {
    if (!online) return;
    void cacheNextClass({
      event_id: eventId,
      summary: className,
      start_at: startAt,
      end_at: null,
      school_id: school.id,
      school_name: school.name,
      school_lat: school.lat,
      school_lng: school.lng,
      school_radius_m: school.radiusM,
    });
  }, [online, eventId, className, startAt, school.id, school.name, school.lat, school.lng, school.radiusM]);

  const hasSchoolCoords = school.lat != null && school.lng != null;

  function locate() {
    setGeoError(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError("unsupported");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        setLocating(false);
        setPosition(null);
        if (err.code === err.PERMISSION_DENIED) setGeoError("denied");
        else if (err.code === err.TIMEOUT) setGeoError("timeout");
        else setGeoError("unavailable");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  if (!hasSchoolCoords) {
    return (
      <p className="rounded-2xl bg-warning-container p-4 text-sm text-on-warning-container">
        {school.name}&apos;s location hasn&apos;t been set yet, so clock-in can&apos;t verify you&apos;re there. Ask a
        manager to set the school&apos;s map location.
      </p>
    );
  }

  const distance =
    position != null ? haversineMeters(position.lat, position.lng, school.lat!, school.lng!) : null;
  const inside = distance != null && distance <= school.radiusM;
  const lowAccuracy = position != null && position.accuracy > LOW_ACCURACY_THRESHOLD_M;
  const canClockIn = inside && !lowAccuracy;

  const previewStatus = computeClockInStatus(startAt ? new Date(startAt) : null, new Date());
  const lateBy = minutesLate(startAt ? new Date(startAt) : null, new Date());

  // Offline clock-in: the browser can't reach the server, so record it locally
  // in the sync queue (idempotent client_key) after the same on-device
  // geofence check gated the button. The server re-validates the fence and the
  // timestamp when the queue drains on reconnect — this is optimistic, not the
  // authority. crypto.randomUUID inside enqueueClockIn is the session's key.
  async function clockInOffline() {
    if (!position || !canClockIn) return;
    setSavingOffline(true);
    await enqueueClockIn({
      event_id: eventId,
      school_id: school.id,
      lat: position.lat,
      lng: position.lng,
      accuracy: position.accuracy,
      clock_in_at: new Date().toISOString(),
    });
    setSavingOffline(false);
    setOfflineSaved(true);
    // If connectivity returned between render and tap, drain immediately.
    void syncNow();
  }

  if (offlineSaved) {
    return (
      <div className="rounded-2xl bg-tertiary-container p-4 text-on-tertiary-container">
        <p className="font-semibold">Clocked in — saved offline</p>
        <p className="mt-1 text-sm opacity-90">
          You&apos;re clocked in to <span className="font-medium">{className}</span>. This is saved on your device
          and will sync automatically the moment you&apos;re back online — no need to do anything. Your GPS checks
          will be captured on this device in the meantime.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {geoError && (
        <div role="alert" className="rounded-2xl bg-error-container p-4 text-on-error-container">
          <p className="font-semibold">{describeGeoError(geoError).title}</p>
          <p className="mt-1 text-sm opacity-90">{describeGeoError(geoError).detail}</p>
          <button
            type="button"
            onClick={locate}
            className="mt-3 rounded-lg bg-error px-4 py-2 text-sm font-semibold text-on-error"
          >
            Try again
          </button>
        </div>
      )}

      {!position && !geoError && (
        <button
          type="button"
          onClick={locate}
          disabled={locating}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-on-primary shadow-md transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-xl" aria-hidden>
            my_location
          </span>
          {locating ? "Getting your location…" : "Check my location"}
        </button>
      )}

      {position && (
        <>
          <div className="h-64 w-full overflow-hidden rounded-2xl shadow-sm">
            <GeoMap
              teacherLat={position.lat}
              teacherLng={position.lng}
              accuracyM={position.accuracy}
              schoolLat={school.lat!}
              schoolLng={school.lng!}
              radiusM={school.radiusM}
              inside={!!inside}
              schoolLabel={school.name}
            />
          </div>

          <p className="text-sm">
            You&apos;re <span className="font-semibold">{Math.round(distance!)} m</span> from {school.name} (clock-in
            zone: {school.radiusM} m). Location accurate to ±{Math.round(position.accuracy)} m.
          </p>

          {lowAccuracy ? (
            <div role="alert" className="rounded-2xl bg-warning-container p-4 text-on-warning-container">
              <p className="font-semibold">Location too imprecise</p>
              <p className="mt-1 text-sm opacity-90">
                Your fix is only accurate to ±{Math.round(position.accuracy)} m, which can&apos;t confirm you&apos;re
                inside the {school.radiusM} m zone. Move into the open and try again.
              </p>
              <button
                type="button"
                onClick={locate}
                disabled={locating}
                className="mt-3 rounded-lg bg-on-warning-container px-4 py-2 text-sm font-semibold text-warning-container disabled:opacity-50"
              >
                {locating ? "Getting your location…" : "Try again"}
              </button>
            </div>
          ) : !inside ? (
            <div role="alert" className="rounded-2xl bg-error-container p-4 text-on-error-container">
              <p className="font-semibold">You&apos;re outside the clock-in zone</p>
              <p className="mt-1 text-sm opacity-90">Move closer to {school.name} and check your location again.</p>
              <button
                type="button"
                onClick={locate}
                disabled={locating}
                className="mt-3 rounded-lg bg-error px-4 py-2 text-sm font-semibold text-on-error disabled:opacity-50"
              >
                {locating ? "Getting your location…" : "Retry location"}
              </button>
            </div>
          ) : (
            <div className="rounded-2xl bg-tertiary-container p-4 text-on-tertiary-container">
              <p className="font-semibold">You&apos;re inside the clock-in zone</p>
              <p className="mt-1 text-sm opacity-90">
                Clocking in now will be recorded as{" "}
                <span className="font-medium">
                  {STATUS_LABELS[previewStatus]}
                  {previewStatus === "late" && lateBy > 0 ? ` (${lateBy} min)` : ""}
                </span>
                .
              </p>
              {online ? (
                <form action={formAction} className="mt-4">
                  <input type="hidden" name="event_id" value={eventId} />
                  <input type="hidden" name="lat" value={position.lat} />
                  <input type="hidden" name="lng" value={position.lng} />
                  <input type="hidden" name="accuracy" value={position.accuracy} />
                  <input type="hidden" name="client_key" value={clientKey} />
                  <button
                    type="submit"
                    disabled={pending || !canClockIn}
                    className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary text-base font-bold text-on-primary shadow-md transition-transform active:scale-[0.98] disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined" aria-hidden>
                      fingerprint
                    </span>
                    {pending ? `Clocking in to ${className}…` : "Clock in"}
                  </button>
                </form>
              ) : (
                <div className="mt-4">
                  <p className="mb-2 text-xs opacity-90">
                    You&apos;re offline — this will be saved on your device and synced when you reconnect.
                  </p>
                  <button
                    type="button"
                    onClick={clockInOffline}
                    disabled={savingOffline || !canClockIn}
                    className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary text-base font-bold text-on-primary shadow-md transition-transform active:scale-[0.98] disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined" aria-hidden>
                      fingerprint
                    </span>
                    {savingOffline ? "Saving…" : "Clock in (offline)"}
                  </button>
                </div>
              )}
            </div>
          )}

          {state?.error && (
            <p role="alert" className="text-sm font-medium text-error">
              {state.error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
