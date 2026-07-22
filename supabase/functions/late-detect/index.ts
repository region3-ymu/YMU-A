// @ts-nocheck
// Phase 5: flags a scheduled class as a missed clock-in once its start time
// is more than 5 minutes past with no attendance_sessions row for the
// matched teacher, and queues a Regional Manager notification per flag. The
// manager-facing escalation card (two tap-to-call steps) is rendered from
// the flags table in src/app/(app)/flags — this function only detects and
// records. Meant to run on a short interval (e.g. every minute) via
// pg_cron — see NEXT_STEPS.md, same shape as calendar-sync's cron wiring.
import { createClient } from "npm:@supabase/supabase-js@2.110.6";
import { secretsMatch } from "../_shared/secret.ts";

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
  const secret = Deno.env.get("LATE_DETECT_SECRET");
  if (!url || !serviceRoleKey || !secret) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or LATE_DETECT_SECRET is missing.");
    return json({ error: "Late detection is not configured." }, 500);
  }

  if (!(await secretsMatch(request.headers.get("x-late-detect-secret"), secret))) {
    return json({ error: "Unauthorized." }, 401);
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc("detect_late_clockins");
  if (error) {
    console.error("Late detection failed", error);
    return json({ error: error.message }, 500);
  }

  return json({ flagged: data ?? 0 });
});
