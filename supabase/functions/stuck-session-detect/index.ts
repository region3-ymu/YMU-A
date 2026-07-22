// @ts-nocheck
// Phase 9: flags an attendance session that's still open well past a
// reasonable window (Zoho's feedback webhook never arrived — misconfigured
// webhook, a form the teacher never submitted, a network failure) so an
// OM/CPO can force-close it from /flags via admin_close_stuck_session. Same
// shape as late-detect: detect-and-record only, the manager-facing escalation
// card lives in src/app/(app)/flags. Meant to run on a longer interval than
// the 1-minute crons (e.g. every 15 minutes — the threshold itself is
// hours-scale, so sub-minute polling buys nothing) via pg_cron.
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
  const secret = Deno.env.get("STUCK_SESSION_DETECT_SECRET");
  if (!url || !serviceRoleKey || !secret) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or STUCK_SESSION_DETECT_SECRET is missing.");
    return json({ error: "Stuck-session detection is not configured." }, 500);
  }

  if (request.headers.get("x-stuck-session-detect-secret") !== secret) {
    return json({ error: "Unauthorized." }, 401);
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc("detect_stuck_feedback_sessions");
  if (error) {
    console.error("Stuck-session detection failed", error);
    return json({ error: error.message }, 500);
  }

  return json({ flagged: data ?? 0 });
});
