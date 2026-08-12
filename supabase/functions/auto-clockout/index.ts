// @ts-nocheck
// Closes attendance sessions whose class ended a while ago and that the
// teacher never clocked out of.
//
// Introduced with migration 0026's 24-hour feedback window. Before it,
// submitting feedback was what clocked you out, so a session could not be left
// open by accident for long — the teacher was blocked from their next class
// until they dealt with it. Now that the two are decoupled, a teacher can walk
// away without clocking out and nothing would ever close the row.
//
// This is the safety net, not the primary path: clock_in() closes a prior open
// session implicitly (that is what makes back-to-back classes work), and the
// Clock out button is the honest signal. This catches the teacher who finishes
// for the day and doesn't teach again until Thursday.
//
// auto_clock_out_ended_sessions() stamps scheduled_end_at, never now(), so a
// session closed three days late still reports the hours it was scheduled for.
// Reporting is unaffected either way: attendance_period_rows.hours_worked has
// been the scheduled duration since migration 0021.
//
// Same shape as late-detect / stuck-session-detect: detect-and-record only,
// shared-secret header, service-role client, one RPC call. Meant to run on
// pg_cron every 5 minutes — the grace period is minutes-scale, so sub-minute
// polling buys nothing.
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
  const secret = Deno.env.get("AUTO_CLOCKOUT_SECRET");
  if (!url || !serviceRoleKey || !secret) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or AUTO_CLOCKOUT_SECRET is missing.");
    return json({ error: "Auto clock-out is not configured." }, 500);
  }

  if (!(await secretsMatch(request.headers.get("x-auto-clockout-secret"), secret))) {
    return json({ error: "Unauthorized." }, 401);
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc("auto_clock_out_ended_sessions");
  if (error) {
    console.error("Auto clock-out failed", error);
    return json({ error: error.message }, 500);
  }

  return json({ clocked_out: data ?? 0 });
});
