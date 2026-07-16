// TypeScript twin of haversine_meters() in supabase/migrations/0005_schools.sql.
// Kept in sync deliberately: this one runs client-side (offline geofence
// checks, override-distance hints); the SQL one re-validates server-side.

const EARTH_RADIUS_M = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const clampedCos = Math.min(
    1,
    Math.max(
      -1,
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.cos(toRadians(lng2) - toRadians(lng1)) +
        Math.sin(toRadians(lat1)) * Math.sin(toRadians(lat2)),
    ),
  );
  return EARTH_RADIUS_M * Math.acos(clampedCos);
}
