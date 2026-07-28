"use client";

import { useActionState, useState } from "react";
import { REGIONS, REGION_LABELS, type AppRole } from "@/lib/auth/roles";
import { haversineMeters } from "@/lib/geo/haversine";
import { assignSchoolRegion, updateSchoolContact, updateSchoolLocation } from "./actions";
import MapPreview from "./map-preview";
import type { School } from "./types";

const INPUT_CLASSES =
  "rounded-lg bg-surface-container-low px-2 py-1.5 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary";

const SAVE_BUTTON_CLASSES =
  "rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-on-primary shadow-sm active:scale-[0.98] disabled:opacity-40";

function RegionBadge({ region }: { region: School["region"] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2.5 py-1 text-xs font-semibold text-on-primary-container">
      {region ? REGION_LABELS[region] : "Unassigned"}
    </span>
  );
}

function RegionForm({ school }: { school: School }) {
  const [state, action, pending] = useActionState(assignSchoolRegion, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="school_id" value={school.id} />
      <select
        name="region"
        defaultValue={school.region ?? ""}
        className={INPUT_CLASSES}
        aria-label="Region"
      >
        <option value="">Unassigned</option>
        {REGIONS.map((region) => (
          <option key={region} value={region}>
            {REGION_LABELS[region]}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={SAVE_BUTTON_CLASSES}>
        {pending ? "Saving…" : "Save region"}
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-xs text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}

function LocationEditor({ school }: { school: School }) {
  const [state, action, pending] = useActionState(updateSchoolLocation, undefined);
  const [lat, setLat] = useState(String(school.lat ?? ""));
  const [lng, setLng] = useState(String(school.lng ?? ""));

  const drift =
    school.lat != null &&
    school.lng != null &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng))
      ? haversineMeters(school.lat, school.lng, Number(lat), Number(lng))
      : null;

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="school_id" value={school.id} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="lat"
          value={lat}
          onChange={(event) => setLat(event.target.value)}
          inputMode="decimal"
          placeholder="Latitude"
          className={`${INPUT_CLASSES} w-32`}
          aria-label="Latitude"
        />
        <input
          name="lng"
          value={lng}
          onChange={(event) => setLng(event.target.value)}
          inputMode="decimal"
          placeholder="Longitude"
          className={`${INPUT_CLASSES} w-32`}
          aria-label="Longitude"
        />
        <button type="submit" disabled={pending} className={SAVE_BUTTON_CLASSES}>
          {pending ? "Saving…" : "Override pin"}
        </button>
      </div>
      {drift !== null && drift > 1 && (
        <p className="text-xs text-on-surface-variant">
          Moves the pin ~{Math.round(drift)} m from the geocoded location.
        </p>
      )}
      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
      {state?.success && <p className="text-xs text-tertiary">{state.success}</p>}
    </form>
  );
}

function ContactEditor({ school }: { school: School }) {
  const [state, action, pending] = useActionState(updateSchoolContact, undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="school_id" value={school.id} />
      <div className="flex flex-col gap-1">
        <label className="text-xs text-on-surface-variant">Contact name</label>
        <input
          name="contact_name"
          defaultValue={school.contact_name ?? ""}
          className={INPUT_CLASSES}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-on-surface-variant">Contact phone</label>
        <input
          name="contact_phone"
          defaultValue={school.contact_phone ?? ""}
          className={INPUT_CLASSES}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-on-surface-variant">Geofence (m)</label>
        <input
          name="geofence_radius_m"
          type="number"
          min={1}
          defaultValue={school.geofence_radius_m}
          className={`${INPUT_CLASSES} w-20`}
        />
      </div>
      <button type="submit" disabled={pending} className={SAVE_BUTTON_CLASSES}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-xs text-error">
          {state.error}
        </p>
      )}
    </form>
  );
}

export default function SchoolCard({
  school,
  callerRole,
  mapCollapsed,
  onToggleMap,
}: {
  school: School;
  callerRole: AppRole;
  // Map visibility is controlled by the parent (ListsExplorer) so a global
  // "Hide maps" toggle can collapse every card at once, while this callback
  // still lets one specific card be reopened without affecting the rest.
  mapCollapsed: boolean;
  onToggleMap: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canAssignRegion = callerRole === "operations_manager" || callerRole === "cpo";

  return (
    <li className="relative flex flex-col gap-3 overflow-hidden rounded-2xl bg-surface-container p-4 shadow-sm">
      <div className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
            aria-hidden
          >
            <span className="material-symbols-outlined">school</span>
          </span>
          <div>
            <p className="font-semibold text-on-surface">{school.name}</p>
            <p className="text-xs text-on-surface-variant">{school.address}</p>
            {(school.contact_name || school.contact_phone) && (
              <p className="mt-1 flex items-center gap-1 text-xs text-on-surface-variant">
                <span className="material-symbols-outlined text-sm" aria-hidden>
                  call
                </span>
                {school.contact_name}
                {school.contact_name && school.contact_phone ? " · " : ""}
                {school.contact_phone}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canAssignRegion ? <RegionForm school={school} /> : <RegionBadge region={school.region} />}
        </div>
      </div>

      {school.lat != null && school.lng != null ? (
        mapCollapsed ? (
          <button
            type="button"
            onClick={onToggleMap}
            className="inline-flex items-center gap-1 self-start rounded-full bg-surface-container-high px-4 py-2 text-xs font-medium text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-sm" aria-hidden>
              location_on
            </span>
            Show map
          </button>
        ) : (
          <div className="flex flex-col gap-1.5">
            <MapPreview lat={school.lat} lng={school.lng} label={school.name} />
            <button
              type="button"
              onClick={onToggleMap}
              className="self-start text-xs font-medium text-primary"
            >
              Hide map
            </button>
          </div>
        )
      ) : (
        <p className="inline-flex items-center gap-1 rounded-xl bg-warning-container p-4 text-center text-xs text-on-warning-container">
          <span className="material-symbols-outlined text-sm" aria-hidden>
            warning
          </span>
          No coordinates yet — geocoding failed. Add lat/lng below.
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>
          edit_note
        </span>
        {expanded ? "Hide details" : "Edit contact / pin"}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-outline-variant pt-3">
          <ContactEditor school={school} />
          <LocationEditor school={school} />
        </div>
      )}
    </li>
  );
}
