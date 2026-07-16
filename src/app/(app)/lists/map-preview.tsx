"use client";

import dynamic from "next/dynamic";

// Leaflet touches window/document at import time, so it can only load on the
// client. ssr:false is only valid from a Client Component (see Next.js
// lazy-loading guide) — hence this thin wrapper around leaflet-map.tsx.
const LeafletMap = dynamic(() => import("./leaflet-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs opacity-60">
      Loading map…
    </div>
  ),
});

export default function MapPreview({
  lat,
  lng,
  label,
}: {
  lat: number;
  lng: number;
  label?: string;
}) {
  return (
    <div className="h-56 w-full overflow-hidden rounded-xl border border-foreground/10">
      <LeafletMap lat={lat} lng={lng} label={label} />
    </div>
  );
}
