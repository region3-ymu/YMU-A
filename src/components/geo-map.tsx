"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";

// Same string-URL marker as lists/leaflet-map.tsx: a static `import` of the
// PNG throws "iconUrl not set" under this Turbopack version, and /public assets
// stay available offline once the service worker caches them.
const schoolIcon = L.icon({
  iconUrl: "/leaflet/marker-icon.png",
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  shadowUrl: "/leaflet/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const INSIDE = "#16a34a"; // green-600
const OUTSIDE = "#dc2626"; // red-600
const TEACHER = "#2563eb"; // blue-600

// Frame both the geofence circle and the teacher so the whole "am I inside?"
// picture is visible without manual panning. Depends on primitives (not an
// array literal) so it only refits when the coordinates actually change.
function FitToFence({
  schoolLat,
  schoolLng,
  teacherLat,
  teacherLng,
  radiusM,
}: {
  schoolLat: number;
  schoolLng: number;
  teacherLat: number;
  teacherLng: number;
  radiusM: number;
}) {
  const map = useMap();
  useEffect(() => {
    const bounds = L.latLng(schoolLat, schoolLng).toBounds(radiusM * 2.4);
    bounds.extend([teacherLat, teacherLng]);
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 18 });
  }, [map, schoolLat, schoolLng, teacherLat, teacherLng, radiusM]);
  return null;
}

export default function GeoMap({
  teacherLat,
  teacherLng,
  accuracyM,
  schoolLat,
  schoolLng,
  radiusM,
  inside,
  schoolLabel,
}: {
  teacherLat: number;
  teacherLng: number;
  accuracyM?: number | null;
  schoolLat: number;
  schoolLng: number;
  radiusM: number;
  inside: boolean;
  schoolLabel?: string;
}) {
  const fenceColor = inside ? INSIDE : OUTSIDE;
  return (
    <MapContainer
      center={[schoolLat, schoolLng]}
      zoom={16}
      scrollWheelZoom={false}
      className="h-full w-full"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* The geofence: centred on the school, coloured by whether the teacher
          is inside it. */}
      <Circle
        center={[schoolLat, schoolLng]}
        radius={radiusM}
        pathOptions={{ color: fenceColor, fillColor: fenceColor, fillOpacity: 0.1, weight: 2 }}
      />

      <Marker position={[schoolLat, schoolLng]} icon={schoolIcon}>
        <Popup>{schoolLabel ?? "School"}</Popup>
      </Marker>

      {/* GPS accuracy halo, then the teacher's point on top. */}
      {accuracyM != null && accuracyM > 0 && (
        <Circle
          center={[teacherLat, teacherLng]}
          radius={accuracyM}
          pathOptions={{ color: TEACHER, fillColor: TEACHER, fillOpacity: 0.08, weight: 1 }}
        />
      )}
      <CircleMarker
        center={[teacherLat, teacherLng]}
        radius={8}
        pathOptions={{ color: "#ffffff", weight: 2, fillColor: TEACHER, fillOpacity: 1 }}
      >
        <Popup>You are here</Popup>
      </CircleMarker>

      <FitToFence
        schoolLat={schoolLat}
        schoolLng={schoolLng}
        teacherLat={teacherLat}
        teacherLng={teacherLng}
        radiusM={radiusM}
      />
    </MapContainer>
  );
}
