// Local runner for the calendar sync — a Node counterpart to the Deno Edge
// Function (supabase/functions/calendar-sync/index.ts). It calls the exact
// same syncCalendar() core so local verification exercises the real logic
// without needing Docker / `supabase functions serve`.
//
//   npm run sync:calendar
//
// Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CALENDAR_ID
// and GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 from .env.local (via --env-file in the
// npm script). Runs against the hosted project with the service-role key, so
// treat it like any other admin script.
//
// Runs under Node's native TypeScript stripping (Node 22.6+/24); no build step.

import { createClient } from "@supabase/supabase-js";
import { syncCalendar } from "../supabase/functions/calendar-sync/sync.ts";

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

  const result = await syncCalendar(supabase, {
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID,
    GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
