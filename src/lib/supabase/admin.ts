import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client. Bypasses RLS entirely — server-only, never import this
// from a client component or anything that ships to the browser. Used by the
// Zoho feedback webhook route handler, which has no teacher session (Zoho
// calls it directly) and must close attendance_sessions via
// close_session_from_zoho(), a function granted to service_role only.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
