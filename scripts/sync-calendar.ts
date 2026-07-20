// Local runner for the calendar sync — a Node counterpart to the Deno Edge
// Function (supabase/functions/calendar-sync/index.ts). It calls the exact
// same syncAllCalendars() core so local verification exercises the real
// logic without needing Docker / `supabase functions serve`.
//
//   npm run sync:calendar
//   CALENDAR_SYNC_DRY_RUN=1 npm run sync:calendar   # discovery/matching only, no writes
//
// Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 from .env.local (via --env-file in the
// npm script). Runs against the hosted project with the service-role key, so
// treat it like any other admin script. GOOGLE_CALENDAR_ID is no longer read
// here — the service account's calendarList is discovered directly.
//
// Runs under Node's native TypeScript stripping (Node 22.6+/24); no build step.

import { createClient } from "@supabase/supabase-js";
import { syncAllCalendars } from "../supabase/functions/calendar-sync/sync.ts";

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running the sync.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const dryRun = Boolean(process.env.CALENDAR_SYNC_DRY_RUN);
  if (dryRun) console.log("CALENDAR_SYNC_DRY_RUN set — discovery/matching only, no writes.");

  const result = await syncAllCalendars(
    supabase,
    { GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 },
    { dryRun },
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
