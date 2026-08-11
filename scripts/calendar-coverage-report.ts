// Read-only reconciliation report: Google Calendar <-> schools <-> the official
// roster. Writes calendar-coverage-report.csv and prints a summary.
//
//   node --env-file=.env.local scripts/calendar-coverage-report.ts
//   ROSTER_CSV=~/Downloads/roster.csv node --env-file=.env.local scripts/...
//
// The in-app queue at /schedules only ever shows one direction — calendars that
// failed to match a school. It cannot show the two gaps that actually matter
// when the roster grows: schools with no calendar, and roster entries with no
// school row at all. This reports all four quadrants at once.
//
// Never writes to the database or to Google. Safe to run any time.

import { createClient } from "@supabase/supabase-js";
import {
  GoogleCalendarClient,
  listAllCalendars,
  parseServiceAccount,
} from "../src/lib/google/calendar.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROSTER_CSV =
  process.env.ROSTER_CSV ??
  path.join(os.homedir(), "Downloads", "Schools with addresses - Sheet1.csv");
const OUT_CSV = path.resolve("calendar-coverage-report.csv");

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running.`);
    process.exit(1);
  }
  return value;
}

// Same normalization the school importer uses, so "matched here" and "matched
// there" can never disagree. Ported from the sibling School-Visit-Planning
// project's verify-geocoding.ts, which learned these cases the hard way.
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

// Minimal RFC-4180 reader — the roster is a Google Sheets export with quoted
// addresses containing commas, so split(",") is not good enough.
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

function csvCell(value: string | null | undefined): string {
  const s = (value ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // NOTE: this only sees the service account's calendarList. A calendar that
  // was *shared* with the service account but never subscribed to is invisible
  // here even though the account can read it — see the comment on
  // subscribeToCalendar() in src/lib/google/calendar.ts. That gap is the usual
  // reason this count comes in under the real number of school calendars.
  const calendars = await listAllCalendars(
    new GoogleCalendarClient(
      parseServiceAccount(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64")),
    ),
  );

  const { data: schools, error } = await supabase
    .from("schools")
    .select("id, name, region, address, lat, lng, google_calendar_id")
    .order("name");
  if (error) throw new Error(`Reading schools failed: ${error.message}`);

  let roster: { name: string; address: string }[] = [];
  if (fs.existsSync(ROSTER_CSV)) {
    const rows = parseCsv(fs.readFileSync(ROSTER_CSV, "utf8"));
    roster = rows.slice(1)
      .filter((r) => r[0]?.trim())
      .map((r) => ({ name: r[0].trim(), address: (r[1] ?? "").trim() }));
  } else {
    console.warn(`Roster CSV not found at ${ROSTER_CSV} — skipping roster columns.`);
  }

  const pinnedCalendarIds = new Set(
    (schools ?? []).map((s) => s.google_calendar_id).filter(Boolean) as string[],
  );
  const schoolByNorm = new Map((schools ?? []).map((s) => [normalizeSchoolName(s.name), s]));
  const rosterByNorm = new Map(roster.map((r) => [normalizeSchoolName(r.name), r]));

  type Row = {
    kind: string;
    name: string;
    detail: string;
    region: string;
    has_calendar: string;
    has_gps: string;
  };
  const out: Row[] = [];

  // 1. Calendars the service account can see that no school is pinned to.
  const unpinnedCalendars = calendars.filter((c) => !pinnedCalendarIds.has(c.id));
  for (const c of unpinnedCalendars) {
    const norm = normalizeSchoolName(c.summary ?? "");
    const school = schoolByNorm.get(norm);
    out.push({
      kind: school ? "calendar_unpinned_school_exists" : "calendar_no_school",
      name: c.summary ?? "(untitled)",
      detail: c.id,
      region: school?.region ?? "",
      has_calendar: "",
      has_gps: school ? (school.lat == null ? "no" : "yes") : "",
    });
  }

  // 2. Schools with no calendar pinned — the direction the in-app queue cannot show.
  for (const s of schools ?? []) {
    if (s.google_calendar_id) continue;
    out.push({
      kind: "school_no_calendar",
      name: s.name,
      detail: s.address ?? "",
      region: s.region ?? "",
      has_calendar: "no",
      has_gps: s.lat == null ? "no" : "yes",
    });
  }

  // 3. Roster entries with no school row at all.
  for (const r of roster) {
    if (schoolByNorm.has(normalizeSchoolName(r.name))) continue;
    out.push({
      kind: "roster_not_in_app",
      name: r.name,
      detail: r.address,
      region: "",
      has_calendar: "",
      has_gps: "",
    });
  }

  // 4. Schools in the app that the roster does not list (possible duplicates
  //    or retired sites — worth a human look, never auto-deleted).
  for (const s of schools ?? []) {
    if (!roster.length) break;
    if (rosterByNorm.has(normalizeSchoolName(s.name))) continue;
    out.push({
      kind: "school_not_in_roster",
      name: s.name,
      detail: s.address ?? "",
      region: s.region ?? "",
      has_calendar: s.google_calendar_id ? "yes" : "no",
      has_gps: s.lat == null ? "no" : "yes",
    });
  }

  const header = "kind,name,detail,region,has_calendar,has_gps";
  const body = out
    .map((r) => [r.kind, r.name, r.detail, r.region, r.has_calendar, r.has_gps].map(csvCell).join(","))
    .join("\n");
  fs.writeFileSync(OUT_CSV, `${header}\n${body}\n`);

  const count = (kind: string) => out.filter((r) => r.kind === kind).length;
  console.log("");
  console.log("  Google calendars visible to the service account : " + calendars.length);
  console.log("  Schools in the app                              : " + (schools?.length ?? 0));
  console.log("  Schools pinned to a calendar                    : " + pinnedCalendarIds.size);
  console.log("  Roster entries (spreadsheet)                    : " + roster.length);
  console.log("");
  console.log("  Calendars with no school at all                 : " + count("calendar_no_school"));
  console.log("  Calendars whose school exists but isn't pinned   : " + count("calendar_unpinned_school_exists"));
  console.log("  Schools with no calendar                        : " + count("school_no_calendar"));
  console.log("  Roster schools missing from the app             : " + count("roster_not_in_app"));
  console.log("  App schools not on the roster                   : " + count("school_not_in_roster"));
  console.log("");
  console.log(`  Wrote ${OUT_CSV}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
