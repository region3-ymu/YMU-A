// School roster importer — two-step, human-reviewed.
//
//   node --env-file=.env.local scripts/import-schools.ts
//       Dry run (default). Reads the roster CSV, matches every entry against
//       the existing schools, and writes school-import-review.csv. No writes.
//
//   IMPORT_ALLOW=1 node --env-file=.env.local scripts/import-schools.ts --apply
//       Reads the REVIEWED school-import-review.csv back in and applies it:
//       geocodes and inserts every row whose action is `create`.
//
// Why two steps: fuzzy-matching school names produces confident-looking
// garbage. On this roster the naive matcher paired "Homestead Senior High"
// with "Homestead Middle School" and "Redondo Elementary" with "Redland
// Elementary" — different schools that would have been silently merged, each
// inheriting the other's geofence, which breaks clock-in for real teachers.
// So the matcher never decides: it proposes, a human confirms the `action`
// column, and only then does anything touch the database.
//
// Roster CSV format: `School Name,Address` with a header row.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROSTER_CSV =
  process.env.ROSTER_CSV ??
  path.join(os.homedir(), "Downloads", "Schools with addresses - Sheet1.csv");
const REVIEW_CSV = path.resolve("school-import-review.csv");

// Confident enough to call it the same school without asking.
const AUTO_MATCH_SCORE = 0.94;
// Below this, treat it as a brand-new school rather than a doubtful match.
const REVIEW_FLOOR_SCORE = 0.72;

const DEFAULT_GEOFENCE_M = 200;

type Region = "central" | "east" | "west" | "north" | "south";

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running.`);
    process.exit(1);
  }
  return value;
}

// Shared with scripts/calendar-coverage-report.ts — keep the two in sync, or
// "matched here" and "matched there" will quietly disagree.
export function normalizeSchoolName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^MDCPS\s*\|\s*/i, "");
  s = s.replace(/\s*-\s*\(\d+\)\s*$/, "");
  s = s.toUpperCase();
  s = s.replace(/[.,'"&/]/g, " ");
  s = s.replace(/\bSENIOR HIGH SCHOOL\b|\bSENIOR HIGH\b|\bHIGH SCHOOL\b|\bSR HIGH\b/g, "HS");
  s = s.replace(/\bMIDDLE SCHOOL\b|\bMIDDLE\b/g, "MS");
  s = s.replace(/\bELEMENTARY SCHOOL\b|\bELEMENTARY\b/g, "ES");
  s = s.replace(/\bSCHOOL\b|\bCENTER\b|\bCENTRE\b|\bACADEMY\b|\bLEARNING\b/g, " ");
  s = s.replace(/\bK[\s-]?(\d+)\b/g, "K$1");
  s = s.replace(/\bPK[\s-]?(\d+)\b/g, "PK$1");
  s = s.replace(/[^A-Z0-9 ]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// Dice coefficient over bigrams. Deliberately NOT a library: the only
// consumer is this script and its sibling report, and the whole point is that
// the score is advisory — a human confirms every non-exact match anyway.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let hits = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    hits += Math.min(n, B.get(g) ?? 0);
  }
  for (const n of B.values()) total += n;
  return (2 * hits) / total;
}

// Street address is a stronger identity signal than the name: YMU's roster
// writes the same site as "Carrie P. Meek", "Carie P. Meek/Westview K-8" and
// "Dr. Henry Mack / West Little River K-8", which no name matcher will ever
// reconcile — but the street number and street name are identical. Reduced to
// "<number> <street>" with directionals and suffixes normalized, so
// "2450 NW 84th Street" and "2450 NW 84th St, Miami, FL 33147 (…)" collapse
// to the same key.
export function addressKey(raw: string): string | null {
  if (!raw) return null;
  let s = raw.toUpperCase().replace(/\(.*?\)/g, " ");
  s = s.split(",")[0];
  s = s.replace(/[.,'"]/g, " ");
  s = s.replace(/\bSTREET\b/g, "ST").replace(/\bAVENUE\b/g, "AVE");
  s = s.replace(/\bROAD\b/g, "RD").replace(/\bDRIVE\b/g, "DR");
  s = s.replace(/\bTERRACE\b/g, "TER").replace(/\bPLACE\b/g, "PL");
  s = s.replace(/\bCOURT\b/g, "CT").replace(/\bCIRCLE\b/g, "CIR");
  s = s.replace(/\bBOULEVARD\b/g, "BLVD").replace(/\bLANE\b/g, "LN");
  s = s.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // Must start with a street number, else it isn't a usable address.
  const m = s.match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  // Drop a trailing city/state tail that survived the comma split.
  const street = m[2].replace(/\b(MIAMI|MIAMI DADE|FL|FLORIDA)\b/g, " ").replace(/\s+/g, " ").trim();
  return street ? `${m[1]} ${street}` : null;
}

// A school name that says "Middle" cannot be the same school as one that says
// "Senior High", however similar the rest of the string is. This single guard
// is what kills the dangerous false positives the roster produces.
const LEVEL_TOKENS = ["HS", "MS", "ES", "K8", "K5", "K12", "PK8"] as const;
function levelsConflict(a: string, b: string): boolean {
  const levelsOf = (s: string) =>
    new Set(LEVEL_TOKENS.filter((t) => new RegExp(`\\b${t}\\b`).test(s)));
  const la = levelsOf(a);
  const lb = levelsOf(b);
  if (!la.size || !lb.size) return false;
  for (const t of la) if (lb.has(t)) return false;
  return true;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

function csvCell(value: string | number | null | undefined): string {
  const s = (value ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type SchoolRow = { id: string; name: string; region: Region | null; address: string | null };

async function loadSchools(supabase: SupabaseClient): Promise<SchoolRow[]> {
  const { data, error } = await supabase
    .from("schools")
    .select("id, name, region, address")
    .order("name");
  if (error) throw new Error(`Reading schools failed: ${error.message}`);
  return (data ?? []) as SchoolRow[];
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRun(supabase: SupabaseClient) {
  if (!fs.existsSync(ROSTER_CSV)) {
    console.error(`Roster CSV not found: ${ROSTER_CSV}`);
    console.error("Set ROSTER_CSV=/path/to/roster.csv to point somewhere else.");
    process.exit(1);
  }
  const schools = await loadSchools(supabase);
  const rows = parseCsv(fs.readFileSync(ROSTER_CSV, "utf8"));
  const roster = rows.slice(1)
    .filter((r) => r[0]?.trim())
    .map((r) => ({ name: r[0].trim(), address: (r[1] ?? "").trim() }));

  type Out = {
    action: string;
    roster_name: string;
    roster_address: string;
    matched_school: string;
    match_score: string;
    region: string;
    note: string;
  };
  const out: Out[] = [];

  const byAddress = new Map<string, SchoolRow>();
  for (const school of schools) {
    const key = addressKey(school.address ?? "");
    if (key && !byAddress.has(key)) byAddress.set(key, school);
  }

  for (const entry of roster) {
    const norm = normalizeSchoolName(entry.name);
    let best: { school: SchoolRow; score: number } | null = null;
    for (const school of schools) {
      const sNorm = normalizeSchoolName(school.name);
      if (levelsConflict(norm, sNorm)) continue;
      const score = similarity(norm, sNorm);
      if (!best || score > best.score) best = { school, score };
    }

    // Same street address as an existing school: same site, whatever the names
    // say. Checked before the name score so a renamed school can never be
    // duplicated. The level guard still applies — a middle and a senior high
    // genuinely can share a campus address.
    const addrMatch = byAddress.get(addressKey(entry.address) ?? " ");
    if (addrMatch && !levelsConflict(norm, normalizeSchoolName(addrMatch.name))) {
      out.push({
        action: "skip_exists",
        roster_name: entry.name,
        roster_address: entry.address,
        matched_school: addrMatch.name,
        match_score: "address",
        region: addrMatch.region ?? "",
        note: "Same street address as an existing school.",
      });
      continue;
    }
    if (addrMatch) {
      out.push({
        action: "REVIEW",
        roster_name: entry.name,
        roster_address: entry.address,
        matched_school: addrMatch.name,
        match_score: "address/level-conflict",
        region: addrMatch.region ?? "",
        note: "Same address but a different school level — separate school, or a roster typo?",
      });
      continue;
    }

    if (best && best.score >= AUTO_MATCH_SCORE) {
      out.push({
        action: "skip_exists",
        roster_name: entry.name,
        roster_address: entry.address,
        matched_school: best.school.name,
        match_score: best.score.toFixed(3),
        region: best.school.region ?? "",
        note: "Already in the app.",
      });
    } else if (best && best.score >= REVIEW_FLOOR_SCORE) {
      out.push({
        action: "REVIEW",
        roster_name: entry.name,
        roster_address: entry.address,
        matched_school: best.school.name,
        match_score: best.score.toFixed(3),
        region: best.school.region ?? "",
        note: "Same school? Set action to skip_exists (yes) or create (no).",
      });
    } else {
      out.push({
        action: "create",
        roster_name: entry.name,
        roster_address: entry.address,
        matched_school: "",
        match_score: best ? best.score.toFixed(3) : "0",
        region: "",
        note: "Fill in region: central|east|west|north|south",
      });
    }
  }

  const header =
    "action,roster_name,roster_address,matched_school,match_score,region,note";
  fs.writeFileSync(
    REVIEW_CSV,
    `${header}\n${out
      .map((r) =>
        [r.action, r.roster_name, r.roster_address, r.matched_school, r.match_score, r.region, r.note]
          .map(csvCell)
          .join(","),
      )
      .join("\n")}\n`,
  );

  const n = (a: string) => out.filter((r) => r.action === a).length;
  console.log("");
  console.log(`  Roster entries      : ${roster.length}`);
  console.log(`  Already in the app  : ${n("skip_exists")}`);
  console.log(`  NEEDS REVIEW        : ${n("REVIEW")}`);
  console.log(`  To create           : ${n("create")}`);
  console.log("");
  console.log(`  Wrote ${REVIEW_CSV}`);
  console.log("");
  console.log("  Next: open that file, resolve every REVIEW row, fill in the");
  console.log("  region for every `create` row, then run:");
  console.log("    IMPORT_ALLOW=1 node --env-file=.env.local scripts/import-schools.ts --apply");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const REGIONS = new Set(["central", "east", "west", "north", "south"]);

// Census first (free, no rate limit, authoritative for US street addresses),
// Nominatim as the fallback. Mirrors the provider order already used by
// src/lib/geocode.ts; duplicated here rather than imported because that module
// is a server action wired to the app's request context.
async function geocode(address: string): Promise<{ lat: number; lng: number; source: string } | null> {
  const census = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  census.searchParams.set("address", address);
  census.searchParams.set("benchmark", "Public_AR_Current");
  census.searchParams.set("format", "json");
  try {
    const res = await fetch(census, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const json = await res.json();
      const match = json?.result?.addressMatches?.[0];
      if (match?.coordinates) {
        return { lat: match.coordinates.y, lng: match.coordinates.x, source: "census" };
      }
    }
  } catch { /* fall through to Nominatim */ }

  const nominatim = new URL("https://nominatim.openstreetmap.org/search");
  nominatim.searchParams.set("q", address);
  nominatim.searchParams.set("format", "json");
  nominatim.searchParams.set("limit", "1");
  try {
    const res = await fetch(nominatim, {
      headers: { "user-agent": "YMU-A school importer (region3@ymu.org)" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json) && json[0]) {
        return { lat: Number(json[0].lat), lng: Number(json[0].lon), source: "nominatim" };
      }
    }
  } catch { /* give up */ }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apply(supabase: SupabaseClient) {
  if (process.env.IMPORT_ALLOW !== "1") {
    console.error("Refusing to write without IMPORT_ALLOW=1.");
    console.error("This inserts rows into the live schools table.");
    process.exit(1);
  }
  if (!fs.existsSync(REVIEW_CSV)) {
    console.error(`${REVIEW_CSV} not found. Run the dry run first.`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(REVIEW_CSV, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const records = rows.slice(1).map((r) => ({
    action: (r[idx("action")] ?? "").trim(),
    name: (r[idx("roster_name")] ?? "").trim(),
    address: (r[idx("roster_address")] ?? "").trim(),
    region: (r[idx("region")] ?? "").trim().toLowerCase(),
  }));

  const unresolved = records.filter((r) => r.action.toUpperCase() === "REVIEW");
  if (unresolved.length) {
    console.error(`${unresolved.length} row(s) still marked REVIEW. Resolve them first:`);
    for (const r of unresolved.slice(0, 10)) console.error(`  - ${r.name}`);
    console.error("");
    console.error("Set each one to skip_exists (already in the app), create (new school),");
    console.error("or defer (decide later — the import will skip it and say so).");
    process.exit(1);
  }

  // `defer` is deliberately loud rather than silent: an import that quietly
  // drops rows reads as "everything imported" when it didn't.
  const deferred = records.filter((r) => r.action === "defer");
  for (const r of deferred) console.log(`  DEFERRED (not created): ${r.name}`);

  const toCreate = records.filter((r) => r.action === "create");
  const badRegion = toCreate.filter((r) => !REGIONS.has(r.region));
  if (badRegion.length) {
    console.error(`${badRegion.length} row(s) to create have no valid region:`);
    for (const r of badRegion.slice(0, 10)) console.error(`  - ${r.name} (region="${r.region}")`);
    console.error("Valid regions: central, east, west, north, south");
    process.exit(1);
  }

  const existing = await loadSchools(supabase);
  const existingNorm = new Set(existing.map((s) => normalizeSchoolName(s.name)));

  let created = 0;
  let skipped = 0;
  let ungeocoded = 0;

  for (const r of toCreate) {
    if (existingNorm.has(normalizeSchoolName(r.name))) {
      console.log(`  skip (already exists): ${r.name}`);
      skipped++;
      continue;
    }

    const geo = r.address ? await geocode(r.address) : null;
    if (!geo) ungeocoded++;
    // Nominatim's policy is 1 request/second; the Census call is unmetered but
    // pacing both keeps the loop honest either way.
    await sleep(1100);

    const { error } = await supabase.from("schools").insert({
      name: r.name,
      address: r.address || "(address pending)",
      region: r.region,
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      geocode_source: geo?.source ?? null,
      geofence_radius_m: DEFAULT_GEOFENCE_M,
    });
    if (error) {
      console.error(`  FAILED ${r.name}: ${error.message}`);
      continue;
    }
    existingNorm.add(normalizeSchoolName(r.name));
    created++;
    console.log(
      `  created: ${r.name} [${r.region}] ${geo ? `${geo.lat.toFixed(5)},${geo.lng.toFixed(5)} (${geo.source})` : "NO COORDINATES"}`,
    );
  }

  console.log("");
  console.log(`  Created            : ${created}`);
  console.log(`  Skipped (existed)  : ${skipped}`);
  console.log(`  Without coordinates: ${ungeocoded}`);
  if (ungeocoded) {
    console.log("");
    console.log("  A school with no coordinates CANNOT be clocked into — clock_in()");
    console.log("  checks the geofence. Fix those on /lists before their first class.");
  }
}

async function main() {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  if (process.argv.includes("--apply")) await apply(supabase);
  else await dryRun(supabase);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
