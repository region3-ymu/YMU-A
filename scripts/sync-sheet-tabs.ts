// Mirrors the app's data into the YMU spreadsheet, one tab per thing.
//
//   npm run sync:sheet:full
//
// Separate from sync-feedback-sheet.ts on purpose. That one appends new
// feedback rows and never revisits them; this one REPLACES each tab's contents
// wholesale, because everything it carries — a ticket's status, a session's
// clock-out, a flag's resolution — changes after it is first written.
//
// Safe to run as often as you like: replacing is idempotent, so running it
// twice produces the same sheet, not two copies. That is the property the
// append-based sync cannot offer and the reason for the split.

import { parseServiceAccount } from "../src/lib/google/calendar.ts";
import { ensureTab, overwriteRows, readTabMeta, type SheetCell } from "../src/lib/google/sheets.ts";
import { SHEET_TABS, toTabRow } from "../src/lib/google/sheet-tabs.ts";
import { createClient } from "@supabase/supabase-js";

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running.`);
    process.exit(1);
  }
  return value;
}

// PostgREST caps a response at db-max-rows — 1000 on Supabase's defaults — and
// does NOT report that it truncated. The first run of this script mirrored
// 1000 of 6,855 attendance rows and called it a success, which is precisely
// the failure that would have had someone build a term's dashboard on a
// seventh of the data. Page until a short page comes back.
const PAGE = 1000;

async function readAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  rpc: string,
  args?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc(rpc, args ?? {})
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reading ${rpc} failed — ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

async function main() {
  const spreadsheetId = requireEnv("FEEDBACK_SHEET_ID");
  const serviceAccount = parseServiceAccount(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"));
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log(`Mirroring ${SHEET_TABS.length} tabs …\n`);
  let total = 0;

  // Read the spreadsheet's shape ONCE. See readTabMeta: the quota that binds
  // is per-minute per-user, and letting every tab look this up itself was 14
  // of 36 requests per run.
  let meta = await readTabMeta(serviceAccount, spreadsheetId);

  for (const tab of SHEET_TABS) {
    const rows = await readAll(supabase, tab.rpc, tab.args);
    const created = await ensureTab(serviceAccount, spreadsheetId, tab.name, meta);
    // A new tab is not in the snapshot taken above, so refresh it — once, and
    // only on the run that actually creates something.
    if (created) meta = await readTabMeta(serviceAccount, spreadsheetId);
    const values: SheetCell[][] = rows.map((row) => toTabRow(tab, row));
    await overwriteRows(serviceAccount, spreadsheetId, tab.name, [...tab.header], values, meta);

    total += rows.length;
    console.log(`  ${created ? "＋" : "·"} ${tab.name.padEnd(16)} ${rows.length} row(s)`);
  }

  console.log(`\nDone. ${total} row(s) across ${SHEET_TABS.length} tabs.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
