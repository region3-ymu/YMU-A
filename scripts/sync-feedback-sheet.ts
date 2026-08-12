// Mirrors feedback submissions into the YMU Google Sheet.
//
//   node --env-file=.env.local scripts/sync-feedback-sheet.ts
//
// Appends every row that has not been mirrored yet, then stamps them. Safe to
// run repeatedly and safe to interrupt: the stamp happens only after Google
// confirms the append, so a crash mid-run leaves rows pending and the next run
// picks them up. The one failure it cannot prevent is a duplicate — if the
// append succeeds and the process dies before stamping, those rows go in
// twice. Rare, visible, and far better than the alternative of stamping first
// and silently losing them.
//
// Set FEEDBACK_SHEET_ID in .env.local. The sheet must be shared with the
// service account as an EDITOR (reader cannot append).

import { parseServiceAccount } from "../src/lib/google/calendar.ts";
import { appendRows, ensureHeader, resolveSheetName, type SheetCell } from "../src/lib/google/sheets.ts";
import { HEADER, toSheetRow } from "../src/lib/google/feedback-sheet-columns.ts";
import { createClient } from "@supabase/supabase-js";

const PREFERRED_SHEET = process.env.FEEDBACK_SHEET_NAME?.trim() || "Feedback";
const BATCH = 500;

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const spreadsheetId = requireEnv("FEEDBACK_SHEET_ID");
  const serviceAccount = parseServiceAccount(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"));
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // A new spreadsheet's only tab is "Sheet1"; writing to a tab that does not
  // exist fails with an unhelpful 400, so take whichever tab is actually there.
  const sheetName = await resolveSheetName(serviceAccount, spreadsheetId, PREFERRED_SHEET);
  const wroteHeader = await ensureHeader(serviceAccount, spreadsheetId, sheetName, HEADER);
  console.log(`  sheet tab: "${sheetName}"${wroteHeader ? " (header written)" : ""}`);

  let total = 0;
  for (;;) {
    const { data, error } = await supabase.rpc("feedback_for_sheet", { p_limit: BATCH });
    if (error) throw new Error(`Reading pending feedback failed: ${error.message}`);
    const pending = (data ?? []) as Record<string, unknown>[];
    if (pending.length === 0) break;

    const rows: SheetCell[][] = pending.map(toSheetRow);

    await appendRows(serviceAccount, spreadsheetId, `${sheetName}!A1`, rows);

    // Stamp only after Google confirmed the write.
    const ids = pending.map((r) => String(r.id));
    const { error: markError } = await supabase.rpc("mark_feedback_sheet_synced", { p_ids: ids });
    if (markError) {
      throw new Error(
        `Rows were appended but could NOT be marked synced (${markError.message}). `
        + `Re-running will duplicate them — mark them by hand first.`,
      );
    }

    total += rows.length;
    console.log(`  appended ${rows.length} row(s)`);
    if (pending.length < BATCH) break;
  }

  console.log(total === 0 ? "  nothing pending — the sheet is up to date." : `\nDone. ${total} row(s) mirrored.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
