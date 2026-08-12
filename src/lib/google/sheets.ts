// Appending rows to a Google Sheet with the same service account that reads
// the calendars.
//
// Deliberately tiny: one call, values.append. YMU needs feedback to land in a
// spreadsheet they can pivot and chart without exporting a CSV first, and the
// full Sheets API is a large surface to take on for that.
//
// The sheet must be shared with the service account as an Editor. Reader is
// not enough — appending is a write — and the failure looks like a 403 that
// says nothing about sharing, which is worth knowing before debugging it.

import {
  getGoogleAccessToken,
  GoogleCalendarError,
  type GoogleServiceAccount,
} from "./calendar.ts";

// Narrowest scope that can append. drive.file would also work but grants
// access to every file the account creates, which is broader than one sheet.
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export type SheetCell = string | number | boolean | null;

// A 403 from Sheets has two very different causes and Google's own message is
// the only way to tell them apart. Guessing "not shared" when the API is
// simply switched off sends whoever is debugging to the wrong console page.
function describe403(body: string, clientEmail: string): string {
  return body.includes("SERVICE_DISABLED") || body.includes("has not been used in project")
    ? "The Google Sheets API is not enabled on the service account's Cloud project. "
      + "Enable it at console.cloud.google.com → APIs & Services → Enable APIs → "
      + "\"Google Sheets API\", then retry."
    : `Google refused access (403). Share the spreadsheet with ${clientEmail} as an Editor.`;
}

/**
 * Appends rows after the last non-empty row of `range`.
 *
 * USER_ENTERED, not RAW: it lets Sheets parse dates and numbers into real
 * types, so a column of timestamps sorts chronologically and a count column
 * can be summed. With RAW everything arrives as text and every downstream
 * chart has to coerce it back.
 */
export async function appendRows(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  range: string,
  rows: SheetCell[][],
): Promise<number> {
  if (rows.length === 0) return 0;

  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  const url =
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`
    + `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GoogleCalendarError(
      response.status === 403
        ? describe403(body, serviceAccount.client_email)
        : `Google Sheets append failed (${response.status}).`,
      response.status,
      body,
    );
  }

  return rows.length;
}

/**
 * The tab to write to: the requested one if it exists, otherwise the first.
 *
 * A brand-new spreadsheet's only tab is called "Sheet1", and a range naming a
 * tab that does not exist fails with a 400 that mentions parsing, not naming —
 * so guessing wrong is a genuinely confusing failure. Resolving it means YMU
 * can name the tab whatever they like without touching config.
 */
export async function resolveSheetName(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  preferred?: string,
): Promise<string> {
  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  const response = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GoogleCalendarError(
      response.status === 403
        ? describe403(body, serviceAccount.client_email)
        : `Could not open the spreadsheet (${response.status}). Check the id is correct.`,
      response.status,
      body,
    );
  }
  const data = (await response.json()) as { sheets?: { properties?: { title?: string } }[] };
  const titles = (data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[];
  if (titles.length === 0) throw new Error("That spreadsheet has no sheets.");
  if (preferred && titles.includes(preferred)) return preferred;
  return titles[0];
}

/**
 * Writes the header row when the sheet has none, and widens it when the export
 * has grown new columns on the right.
 *
 * Both halves are checked rather than assumed. Appending a header to a sheet
 * that already has data would bury a header row in the middle of the dataset,
 * where nothing downstream would notice until a chart came out wrong. And a
 * header that stays narrower than the rows is the same failure wearing a
 * different hat: migration 0032 added two columns at the end, and without this
 * every row written afterwards would carry two unlabelled fields that a
 * manager reading the sheet has no way to interpret.
 *
 * Widening only ever happens when the existing header is SHORTER — the columns
 * already there keep their positions, so no historic row changes meaning. An
 * existing header of equal or greater width is left exactly as it is, which
 * keeps a hand-edited heading from being clobbered every two minutes by cron.
 */
export async function ensureHeader(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  sheetName: string,
  header: string[],
): Promise<boolean> {
  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  // The whole first row, not just A1: its WIDTH is what decides below.
  const range = `${sheetName}!1:1`;
  const response = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GoogleCalendarError(
      response.status === 403
        ? describe403(body, serviceAccount.client_email)
        : `Could not read the spreadsheet (${response.status}). Check the id is correct.`,
      response.status,
      body,
    );
  }
  const data = (await response.json()) as { values?: unknown[][] };
  const existing = data.values?.[0] ?? [];
  if (existing.length >= header.length) return false;

  await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${sheetName}!A1`)}`
    + `?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [header] }),
    },
  );
  return true;
}

/**
 * Deletes every data row, keeping the header.
 *
 * `values:clear` blanks the cells but leaves the rows in place, so a sheet
 * cleared that way still reports thousands of empty rows and `appendRows`
 * lands beneath all of them. This uses a DeleteDimension batchUpdate instead,
 * which removes the rows themselves, so the next append starts at row 2.
 *
 * Returns how many data rows were removed. Never touches row 1.
 */
export async function clearDataRows(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  sheetName: string,
): Promise<number> {
  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);

  // The row count and the numeric sheetId, which batchUpdate needs and the
  // human-readable tab name cannot provide.
  const metaResponse = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}`
    + `?fields=sheets(properties(sheetId,title,gridProperties/rowCount))`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!metaResponse.ok) {
    const body = await metaResponse.text().catch(() => "");
    throw new GoogleCalendarError(
      metaResponse.status === 403
        ? describe403(body, serviceAccount.client_email)
        : `Could not read the spreadsheet (${metaResponse.status}).`,
      metaResponse.status,
      body,
    );
  }
  const meta = (await metaResponse.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } } }[];
  };
  const tab = (meta.sheets ?? []).find((s) => s.properties?.title === sheetName)?.properties;
  if (!tab || tab.sheetId == null) throw new Error(`No tab named "${sheetName}" in that spreadsheet.`);

  const rowCount = tab.gridProperties?.rowCount ?? 0;
  if (rowCount <= 1) return 0;

  const response = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            deleteDimension: {
              // startIndex 1 is the second row, zero-based — the header survives.
              range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 1, endIndex: rowCount },
            },
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Could not clear the sheet (${response.status}): ${body}`);
  }
  return rowCount - 1;
}
