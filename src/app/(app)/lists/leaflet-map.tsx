"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";

// react-leaflet's default marker icon references relative URLs that resolve
// against leaflet's own package location, not this app — they 404 under
// bundling. Point it at copies served from /public/leaflet instead (also
// keeps the icon available offline for the PWA, unlike a CDN URL).
const markerIconDefault = L.icon({
  iconUrl: "/leaflet/marker-icon.png",
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  shadowUrl: "/leaflet/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function Recenter({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], map.getZoom());
  }, [map, lat, lng]);
  return null;
}

export default function LeafletMap({
  lat,
  lng,
  label,
}: {
  lat: number;
  lng: number;
  label?: string;
}) {
  return (
    <MapContainer
      center={[lat, lng]}
      zoom={16}
      scrollWheelZoom={false}
      className="h-full w-full"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker position={[lat, lng]} icon={markerIconDefault}>
        {label && <Popup>{label}</Popup>}
      </Marker>
      <Recenter lat={lat} lng={lng} />
    </MapContainer>
  );
}
