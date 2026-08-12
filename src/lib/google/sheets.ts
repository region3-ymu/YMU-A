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
 * Writes the header row, once, only if the sheet is empty.
 *
 * Checked rather than assumed: appending a header to a sheet that already has
 * data would bury a header row in the middle of the dataset, where nothing
 * downstream would notice until a chart came out wrong.
 */
export async function ensureHeader(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  sheetName: string,
  header: string[],
): Promise<boolean> {
  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  const range = `${sheetName}!A1:A1`;
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
  if (data.values?.length) return false;

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
