// Bulk-precompute real driving times between every pair of geocoded schools,
// into public.school_travel_times — read by travel_minutes() (0093) so the
// substitute finder prefers an actual OpenRouteService driving duration over
// its straight-line-distance fallback.
//
// Same shape as School-Visit-Planning-YMU's build-distance-matrix.ts /
// TravelMatrixCache, adapted from Prisma to this app's Supabase schema.
//
// Run once now, and again only when a school is added or its lat/lng is
// corrected — routing costs between existing schools don't change on their
// own, so there is no cron for this.
//
//   npm run travel:matrix

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/driving-car";

// ORS's free-tier /v2/matrix endpoint caps routes (origins x destinations)
// per request. 40x40=1,600 stays well under that and under the per-minute
// rate limit alongside the delay below.
const BLOCK_SIZE = 40;
const BATCH_DELAY_MS = 1500;

type School = { id: string; lat: number; lng: number };

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running.`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadSchools(supabase: SupabaseClient): Promise<School[]> {
  const { data, error } = await supabase
    .from("schools")
    .select("id, lat, lng")
    .not("lat", "is", null)
    .not("lng", "is", null)
    .order("name");
  if (error) throw new Error(`Reading schools failed: ${error.message}`);
  return (data ?? []) as School[];
}

async function getMatrix(
  apiKey: string,
  origins: School[],
  destinations: School[],
): Promise<{ durations: number[][]; distances: number[][] }> {
  const locations = [...origins, ...destinations].map((s) => [s.lng, s.lat]);
  const sources = origins.map((_, i) => i);
  const destinationIndices = destinations.map((_, i) => origins.length + i);

  const res = await fetch(ORS_MATRIX_URL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      locations,
      sources,
      destinations: destinationIndices,
      metrics: ["duration", "distance"],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouteService matrix failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { durations?: number[][]; distances?: number[][] };
  return { durations: data.durations ?? [], distances: data.distances ?? [] };
}

async function main() {
  const apiKey = requireEnv("OPENROUTE_SERVICE_API_KEY");
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const schools = await loadSchools(supabase);
  console.log(`[MATRIX] ${schools.length} geocoded schools`);
  if (schools.length < 2) {
    console.log("[MATRIX] Need at least 2 schools to build a matrix. Nothing to do.");
    return;
  }

  const blocks = chunk(schools, BLOCK_SIZE);
  const totalBatches = blocks.length * blocks.length;
  let batchesRun = 0;
  let pairsWritten = 0;

  for (const originBlock of blocks) {
    for (const destBlock of blocks) {
      const result = await getMatrix(apiKey, originBlock, destBlock);
      batchesRun++;

      const rows: {
        school_a: string;
        school_b: string;
        drive_minutes: number;
        distance_m: number;
      }[] = [];

      for (let i = 0; i < originBlock.length; i++) {
        for (let j = 0; j < destBlock.length; j++) {
          if (originBlock[i].id === destBlock[j].id) continue;
          const dur = result.durations[i]?.[j];
          const dist = result.distances[i]?.[j];
          if (dur == null || dist == null || !Number.isFinite(dur) || !Number.isFinite(dist)) {
            continue;
          }
          rows.push({
            school_a: originBlock[i].id,
            school_b: destBlock[j].id,
            drive_minutes: Math.ceil(dur / 60),
            distance_m: Math.round(dist),
          });
        }
      }

      if (rows.length > 0) {
        const { error } = await supabase
          .from("school_travel_times")
          .upsert(rows, { onConflict: "school_a,school_b" });
        if (error) throw new Error(`Writing school_travel_times failed: ${error.message}`);
        pairsWritten += rows.length;
      }

      console.log(`[MATRIX] Batch ${batchesRun}/${totalBatches} — ${pairsWritten} pairs cached so far`);
      if (batchesRun < totalBatches) await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`[MATRIX] Done — ${pairsWritten} directed pairs cached across ${schools.length} schools`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
