// Empties the YMU feedback spreadsheet, keeping the header row.
//
//   SHEET_RESET_ALLOW=1 npm run sheet:reset
//
// For a clean slate before a term starts. The database side is separate — this
// only touches Google. Note that rows already mirrored are marked
// sheet_synced_at in feedback_submissions and will NOT be re-appended, so
// clearing the sheet does not bring them back; that is the intent when the
// database was reset too, and the trap if it was not.
import { parseServiceAccount } from "../src/lib/google/calendar.ts";
import { clearDataRows, resolveSheetName } from "../src/lib/google/sheets.ts";

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) { console.error(`Missing ${key}.`); process.exit(1); }
  return value;
}

if (process.env.SHEET_RESET_ALLOW !== "1") {
  console.error(
    "Refusing to run without SHEET_RESET_ALLOW=1.\n" +
    "This permanently deletes every data row in the feedback spreadsheet.",
  );
  process.exit(1);
}

const spreadsheetId = requireEnv("FEEDBACK_SHEET_ID");
const serviceAccount = parseServiceAccount(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"));
const sheetName = await resolveSheetName(
  serviceAccount, spreadsheetId, process.env.FEEDBACK_SHEET_NAME?.trim() || "Feedback",
);
const removed = await clearDataRows(serviceAccount, spreadsheetId, sheetName);
console.log(`  tab "${sheetName}": ${removed} data row(s) deleted, header kept.`);
