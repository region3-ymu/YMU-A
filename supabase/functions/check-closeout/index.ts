// @ts-nocheck
// Phase 5: closes out overdue gps_checks as 'unverifiable' (neutral, no
// flag — a missed check on its own, e.g. app backgrounded or phone locked,
// isn't suspicious). Meant to run on a short interval (e.g. every minute)
// via pg_cron — see NEXT_STEPS.md for the manual deploy/schedule steps,
// same shape as calendar-sync's cron wiring.
import { createClient } from "npm:@supabase/supabase-js@2.110.6";

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
  const secret = Deno.env.get("CHECK_CLOSEOUT_SECRET");
  if (!url || !serviceRoleKey || !secret) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or CHECK_CLOSEOUT_SECRET is missing.");
    return json({ error: "Check closeout is not configured." }, 500);
  }

  // Same rationale as calendar-sync's x-calendar-sync-secret: pg_cron/pg_net
  // calls carry no user JWT, so verify_jwt is disabled and this header is the
  // whole authorization story.
  if (request.headers.get("x-check-closeout-secret") !== secret) {
    return json({ error: "Unauthorized." }, 401);
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc("close_out_overdue_gps_checks");
  if (error) {
    console.error("Check closeout failed", error);
    return json({ error: error.message }, 500);
  }

  return json({ closed: data ?? 0 });
});
