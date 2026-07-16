// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2.110.6";
import { syncCalendar } from "./sync.ts";

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed. Use POST." }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const syncSecret = Deno.env.get("CALENDAR_SYNC_SECRET");
  if (!url || !serviceRoleKey || !syncSecret) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or CALENDAR_SYNC_SECRET is missing.");
    return json({ error: "Calendar sync is not configured." }, 500);
  }

  // pg_net invokes the function with this secret. verify_jwt is deliberately
  // disabled in config.toml because scheduled HTTP calls do not carry a user
  // JWT; this dedicated secret avoids depending on which valid service-role
  // key Supabase happens to expose to the Edge Runtime.
  if (request.headers.get("x-calendar-sync-secret") !== syncSecret) {
    return json({ error: "Unauthorized." }, 401);
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await syncCalendar(supabase, {
      GOOGLE_CALENDAR_ID: Deno.env.get("GOOGLE_CALENDAR_ID"),
      GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"),
    });
    return json(result);
  } catch (error) {
    console.error("Calendar sync failed", error);
    return json(
      { error: error instanceof Error ? error.message : "Calendar sync failed." },
      500,
    );
  }
});
