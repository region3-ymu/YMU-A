// Mirrors pending feedback into the Google Sheet, on a schedule.
//
// A Next.js route rather than a Supabase Edge Function, which is where the
// other cron jobs live. The reason is code reuse: signing a service-account
// JWT and talking to Google already exists in src/lib/google, and an Edge
// Function would mean either a fragile cross-boundary import of a large module
// or a second copy of the crypto. pg_cron calls this over HTTPS exactly the
// way it calls the Edge Functions, so the scheduling story is unchanged.
//
// Guarded by a shared secret, same shape as the Edge Functions' x-*-secret
// header. Note that /api/* is excluded from the proxy matcher (see proxy.ts),
// so this is never redirected to /login.

import { createClient } from "@supabase/supabase-js";
import { parseServiceAccount } from "@/lib/google/calendar";
import { appendRows, ensureHeader, resolveSheetName, type SheetCell } from "@/lib/google/sheets";
import { HEADER, toSheetRow } from "@/lib/google/feedback-sheet-columns";

// Sheets is slow enough that a large backlog can outlive the default timeout.
export const maxDuration = 60;

const BATCH = 500;

/** Constant-time compare, mirroring supabase/functions/_shared/secret.ts. */
async function secretsMatch(provided: string | null, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided ?? "")),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export async function POST(request: Request) {
  const secret = process.env.SHEET_SYNC_SECRET;
  const spreadsheetId = process.env.FEEDBACK_SHEET_ID;
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret || !spreadsheetId || !serviceAccountKey || !supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: "Sheet sync is not configured." }, { status: 500 });
  }
  if (!(await secretsMatch(request.headers.get("x-sheet-sync-secret"), secret))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const serviceAccount = parseServiceAccount(serviceAccountKey);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const sheetName = await resolveSheetName(
      serviceAccount,
      spreadsheetId,
      process.env.FEEDBACK_SHEET_NAME?.trim() || "Feedback",
    );
    await ensureHeader(serviceAccount, spreadsheetId, sheetName, HEADER);

    const { data, error } = await supabase.rpc("feedback_for_sheet", { p_limit: BATCH });
    if (error) throw new Error(`Reading pending feedback failed: ${error.message}`);
    const pending = (data ?? []) as Record<string, unknown>[];
    if (pending.length === 0) return Response.json({ appended: 0 });

    const rows: SheetCell[][] = pending.map(toSheetRow);

    await appendRows(serviceAccount, spreadsheetId, `${sheetName}!A1`, rows);

    // Stamped only after Google confirms the append, so a failure leaves rows
    // pending for the next run rather than losing them. The one case this
    // cannot cover is dying between the append and the stamp, which duplicates
    // those rows — visible, and better than silently dropping feedback.
    const ids = pending.map((r) => String(r.id));
    const { error: markError } = await supabase.rpc("mark_feedback_sheet_synced", { p_ids: ids });
    if (markError) {
      console.error("Appended to the sheet but could not mark rows synced", markError);
      return Response.json(
        { appended: rows.length, warning: "rows appended but not marked synced" },
        { status: 500 },
      );
    }

    // More waiting? Say so rather than looping — the next tick picks it up, and
    // a backlog should not hold one request open indefinitely.
    return Response.json({ appended: rows.length, more: pending.length === BATCH });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Sheet sync failed", error);
    return Response.json({ error: message }, { status: 500 });
  }
}
