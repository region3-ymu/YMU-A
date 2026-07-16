"use client";

import { useActionState, useState } from "react";
import { REGIONS, REGION_LABELS, type AppRole } from "@/lib/auth/roles";
import { haversineMeters } from "@/lib/geo/haversine";
import { assignSchoolRegion, updateSchoolContact, updateSchoolLocation } from "./actions";
import MapPreview from "./map-preview";
import type { School } from "./types";

const INPUT_CLASSES =
  "rounded-lg border border-foreground/20 bg-background px-2 py-1.5 text-sm";

function RegionBadge({ region }: { region: School["region"] }) {
  return (
    <span className="rounded-full border border-foreground/20 px-2 py-0.5 text-xs opacity-70">
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
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-foreground disabled:opacity-40"
      >
        {pending ? "Saving…" : "Save region"}
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
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
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-foreground disabled:opacity-40"
        >
          {pending ? "Saving…" : "Override pin"}
        </button>
      </div>
      {drift !== null && drift > 1 && (
        <p className="text-xs opacity-60">
          Moves the pin ~{Math.round(drift)} m from the geocoded location.
        </p>
      )}
      {state?.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="text-xs text-green-700 dark:text-green-300">{state.success}</p>
      )}
    </form>
  );
}

function ContactEditor({ school }: { school: School }) {
  const [state, action, pending] = useActionState(updateSchoolContact, undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="school_id" value={school.id} />
      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-60">Contact name</label>
        <input
          name="contact_name"
          defaultValue={school.contact_name ?? ""}
          className={INPUT_CLASSES}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-60">Contact phone</label>
        <input
          name="contact_phone"
          defaultValue={school.contact_phone ?? ""}
          className={INPUT_CLASSES}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-60">Geofence (m)</label>
        <input
          name="geofence_radius_m"
          type="number"
          min={1}
          defaultValue={school.geofence_radius_m}
          className={`${INPUT_CLASSES} w-20`}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-foreground disabled:opacity-40"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}

export default function SchoolCard({
  school,
  callerRole,
}: {
  school: School;
  callerRole: AppRole;
}) {
  const [expanded, setExpanded] = useState(false);
  const canAssignRegion = callerRole === "operations_manager" || callerRole === "cpo";

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-foreground/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{school.name}</p>
          <p className="text-xs opacity-60">{school.address}</p>
          {(school.contact_name || school.contact_phone) && (
            <p className="mt-1 text-xs opacity-60">
              {school.contact_name}
              {school.contact_name && school.contact_phone ? " · " : ""}
              {school.contact_phone}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canAssignRegion ? <RegionForm school={school} /> : <RegionBadge region={school.region} />}
        </div>
      </div>

      {school.lat != null && school.lng != null ? (
        <MapPreview lat={school.lat} lng={school.lng} label={school.name} />
      ) : (
        <p className="rounded-xl border border-dashed border-foreground/20 p-4 text-center text-xs opacity-60">
          No coordinates yet — geocoding failed. Add lat/lng below.
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="self-start text-xs underline opacity-70"
      >
        {expanded ? "Hide details" : "Edit contact / pin"}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-foreground/10 pt-3">
          <ContactEditor school={school} />
          <LocationEditor school={school} />
        </div>
      )}
    </li>
  );
}
