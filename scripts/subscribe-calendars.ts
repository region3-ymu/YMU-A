// One-time (and re-runnable) bootstrap: subscribes the service account's own
// calendarList to a known list of calendar IDs.
//
// Why this exists: sharing a calendar with the service account (via the
// Apps Script bulk-share script) grants real ACL access immediately, but
// does NOT make it show up in calendarList.list() -- there is no UI for a
// service account to "accept" a share the way a human would. Multi-calendar
// sync discovers calendars via calendarList, so a newly shared calendar is
// invisible to it until this script (or an equivalent call) explicitly
// subscribes to it. Run this once after any batch of new calendars is
// shared (e.g. onboarding new schools), then re-run the sync.
//
//   node --env-file=.env.local scripts/subscribe-calendars.ts path/to/calendar-ids.json
//
// The JSON file is either a plain array of calendar id strings, or an array
// of { id: string, name?: string } objects (name is just for a friendlier
// log line; only id matters).
//
// Runs under Node's native TypeScript stripping (Node 22.6+/24); no build step.

import { readFileSync } from "node:fs";
import { GoogleCalendarClient, parseServiceAccount } from "../src/lib/google/calendar.ts";

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running this script.`);
    process.exit(1);
  }
  return value;
}

type CalendarRef = { id: string; name?: string };

function loadCalendarRefs(path: string): CalendarRef[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array in the calendar IDs file.");
  return raw.map((entry) => (typeof entry === "string" ? { id: entry } : entry));
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node --env-file=.env.local scripts/subscribe-calendars.ts <calendar-ids.json>");
    process.exit(1);
  }

  const serviceAccount = parseServiceAccount(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"));
  const client = new GoogleCalendarClient(serviceAccount);
  const refs = loadCalendarRefs(path);

  let subscribed = 0;
  let failed = 0;
  for (const ref of refs) {
    try {
      await client.subscribeToCalendar(ref.id);
      console.log(`Subscribed: ${ref.name ?? ref.id}`);
      subscribed += 1;
    } catch (error) {
      console.error(`FAILED: ${ref.name ?? ref.id} — ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }
    // Small pacing delay, same spirit as syncAllCalendars's inter-calendar delay.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(`\nDone. Subscribed: ${subscribed} | Failed: ${failed} | Total: ${refs.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
