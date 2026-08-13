// Mirrors every non-feedback tab into the YMU spreadsheet, on a schedule.
//
// Separate route from /api/sheet-sync, not a mode flag on it, because the two
// have opposite semantics and opposite cadences. That one APPENDS new feedback
// every 2 minutes and must never re-read what it already sent; this one
// REPLACES each tab wholesale and runs hourly, because the rows it carries —
// a ticket's status, a session's clock-out, a flag's resolution — keep
// changing after they are first written.
//
// Replacing is idempotent, which is the property that makes an hourly full
// rewrite safe: a run that fails halfway is fixed by the next one, with no
// watermark to reconcile and no chance of a duplicate.
//
// Guarded by the same shared secret as the feedback route. /api/* is excluded
// from the proxy matcher (see proxy.ts), so this is never redirected to /login.

import { createClient } from "@supabase/supabase-js";
import { parseServiceAccount } from "@/lib/google/calendar";
import { ensureTab, overwriteRows, type SheetCell } from "@/lib/google/sheets";
import { SHEET_TABS, toTabRow } from "@/lib/google/sheet-tabs";

// Seven tabs and ~7,000 rows of Sheets writes; the default timeout is not
// enough on a cold start.
export const maxDuration = 300;

// PostgREST caps a response at db-max-rows (1000 on Supabase) and does not say
// that it truncated — so a single unpaged read silently mirrors a seventh of
// the attendance tab and reports success.
const PAGE = 1000;

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

  const written: Record<string, number> = {};

  try {
    for (const tab of SHEET_TABS) {
      const rows: Record<string, unknown>[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .rpc(tab.rpc, tab.args ?? {})
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`${tab.name}: ${tab.rpc} failed — ${error.message}`);
        const page = (data ?? []) as unknown as Record<string, unknown>[];
        rows.push(...page);
        if (page.length < PAGE) break;
      }

      await ensureTab(serviceAccount, spreadsheetId, tab.name);
      const values: SheetCell[][] = rows.map((row) => toTabRow(tab, row));
      await overwriteRows(serviceAccount, spreadsheetId, tab.name, [...tab.header], values);
      written[tab.name] = rows.length;
    }

    return Response.json({ tabs: written });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Sheet tabs sync failed", error);
    // Report what did land: a partial run is recoverable — the next hourly
    // tick rewrites every tab from scratch — but only if someone can see
    // which tab it stopped on.
    return Response.json({ error: message, tabs: written }, { status: 500 });
  }
}
