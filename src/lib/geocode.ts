// Geocoding for the "add school by address" flow. Server-only: both
// upstreams are called with a fixed User-Agent / rate limit that only make
// sense from a single trusted caller, not the browser. Only import this from
// server actions or route handlers.
//
// Primary: US Census Bureau one-line address geocoder (free, keyless,
// US-only — fine for Miami-Dade). Fallback: Nominatim, which per its usage
// policy requires a descriptive User-Agent and a max of 1 request/second.

export type GeocodeSource = "census" | "nominatim";

export type GeocodeResult = {
  lat: number;
  lng: number;
  source: GeocodeSource;
  matchedAddress: string;
};

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT = "YMU-A/1.0 (Young Musicians Unite attendance app; ops@ymu.org)";
const NOMINATIM_MIN_INTERVAL_MS = 1000;

// Nominatim's usage policy caps unauthenticated use at 1 req/s. Schools are
// added one at a time by a human, drip-fed (≤255 total), so a module-level
// last-call timestamp is sufficient — no queue needed.
let lastNominatimCallAt = 0;

async function throttleNominatim(): Promise<void> {
  const elapsed = Date.now() - lastNominatimCallAt;
  if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS - elapsed),
    );
  }
  lastNominatimCallAt = Date.now();
}

async function geocodeWithCensus(address: string): Promise<GeocodeResult | null> {
  const url = new URL(CENSUS_URL);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;

  const data = await response.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match?.coordinates) return null;

  const { x, y } = match.coordinates;
  if (typeof x !== "number" || typeof y !== "number") return null;

  return {
    lat: y,
    lng: x,
    source: "census",
    matchedAddress: match.matchedAddress ?? address,
  };
}

async function geocodeWithNominatim(address: string): Promise<GeocodeResult | null> {
  await throttleNominatim();

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;

  const data = await response.json();
  const match = data?.[0];
  if (!match) return null;

  const lat = Number(match.lat);
  const lng = Number(match.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    source: "nominatim",
    matchedAddress: match.display_name ?? address,
  };
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;

  try {
    const censusResult = await geocodeWithCensus(trimmed);
    if (censusResult) return censusResult;
  } catch {
    // Fall through to Nominatim.
  }

  try {
    return await geocodeWithNominatim(trimmed);
  } catch {
    return null;
  }
}
