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

/**
 * fetch, with the retry Google's own docs ask for.
 *
 * The binding quota is 60 requests per MINUTE PER USER, and a service account
 * is one user — so the hourly tab sync (23 requests) and the two-minute
 * feedback sync share one budget and can collide. Google returns 429 for that
 * and recommends truncated exponential backoff; without it a collision means a
 * tab throws and stays a whole hour stale for a condition that clears in
 * seconds.
 *
 * 5xx is retried for the same reason. 4xx other than 429 is not: a bad range
 * or a missing tab will fail identically however long you wait.
 */
async function sheetsFetch(url: string, init?: RequestInit, attempt = 0): Promise<Response> {
  const response = await fetch(url, init);
  const retryable = response.status === 429 || response.status >= 500;
  if (!retryable || attempt >= 4) return response;

  // 1s, 2s, 4s, 8s, plus jitter so two callers backing off together do not
  // simply collide again on the same schedule.
  const waitMs = 2 ** attempt * 1000 + Math.floor(Math.random() * 250);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return sheetsFetch(url, init, attempt + 1);
}

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
 * already there keep their positions, so no historic row changes meaning.
 *
 * It also rewrites when a label has CHANGED, which is how the "(at submission)"
 * warnings on the ticket columns reach a spreadsheet that already has a header.
 * The labels are the code's to own: a human editing one is fighting the
 * exporter, and a wrong label on a column that is quietly frozen is exactly the
 * failure those renames exist to prevent. Only the columns this export knows
 * about are touched — anything a human added to the RIGHT of them is theirs and
 * is left alone.
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
  const matches =
    existing.length >= header.length
    && header.every((label, i) => String(existing[i] ?? "") === label);
  if (matches) return false;

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

/** One tab's identity and grid size, as Google reports it. */
export type TabMeta = {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
};

/**
 * Every tab's id and grid size, in ONE request.
 *
 * Read once per sync run and passed down, because the quota that binds here is
 * 60 requests per minute PER USER and the service account is a single user.
 * Letting ensureTab and overwriteRows each fetch this themselves cost two
 * reads per tab — 14 of a measured 36 requests per run, for information that
 * cannot change mid-run except when this same code adds a tab.
 */
export async function readTabMeta(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
): Promise<TabMeta[]> {
  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  const response = await sheetsFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}`
    + `?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GoogleCalendarError(
      response.status === 403
        ? describe403(body, serviceAccount.client_email)
        : `Could not open the spreadsheet (${response.status}).`,
      response.status,
      body,
    );
  }
  const data = (await response.json()) as {
    sheets?: {
      properties?: {
        sheetId?: number;
        title?: string;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }[];
  };
  return (data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is NonNullable<typeof p> => p?.sheetId != null && p.title != null)
    .map((p) => ({
      sheetId: p.sheetId as number,
      title: p.title as string,
      rowCount: p.gridProperties?.rowCount ?? 0,
      columnCount: p.gridProperties?.columnCount ?? 0,
    }));
}

/**
 * Creates a tab if it is not already there. Returns true if it created one.
 *
 * Pass `known` (from readTabMeta) to skip the lookup — see the note there on
 * why the request count matters.
 */
export async function ensureTab(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  sheetName: string,
  known?: TabMeta[],
): Promise<boolean> {
  const meta = known ?? (await readTabMeta(serviceAccount, spreadsheetId));
  if (meta.some((t) => t.title === sheetName)) return false;

  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  const response = await sheetsFetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Could not create the tab "${sheetName}" (${response.status}): ${body}`);
  }
  return true;
}

/**
 * Replaces a tab's contents: header in row 1, `rows` under it, nothing else.
 *
 * WRITES OVER, THEN BLANKS THE SURPLUS — it never deletes rows. That is the
 * whole difference between this and `clearDataRows` above, and it is not a
 * detail: deleting rows silently breaks every pivot table, chart and named
 * range built on the tab, which is exactly what this data is FOR. A blanked
 * row leaves those references intact and simply reads as empty.
 *
 * Chunked because a single values.update carrying ~7,000 rows is large enough
 * to be refused, and a refusal midway is how a tab ends up half-written.
 */
export async function overwriteRows(
  serviceAccount: GoogleServiceAccount,
  spreadsheetId: string,
  sheetName: string,
  header: string[],
  rows: SheetCell[][],
  known?: TabMeta[],
): Promise<number> {
  const token = await getGoogleAccessToken(serviceAccount, SHEETS_SCOPE);
  const quoted = `'${sheetName.replace(/'/g, "''")}'`;
  const CHUNK = 2000;

  // Grow the grid FIRST. A new tab is 1000 rows x 26 columns, and
  // values.update cannot extend it — writing 6,855 rows into it fails with a
  // 400 that talks about grid limits, not about size. values.append grows the
  // grid implicitly, which is why the feedback sync never hit this.
  const previous = await ensureGrid(
    token, spreadsheetId, sheetName,
    rows.length + 2,
    Math.max(header.length, ...rows.map((r) => r.length), 1),
    known,
  );

  async function put(range: string, values: SheetCell[][]) {
    const response = await sheetsFetch(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
      + `?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GoogleCalendarError(
        response.status === 403
          ? describe403(body, serviceAccount.client_email)
          : `Writing "${sheetName}" failed (${response.status}).`,
        response.status,
        body,
      );
    }
  }

  await put(`${quoted}!A1`, [header]);

  for (let i = 0; i < rows.length; i += CHUNK) {
    await put(`${quoted}!A${i + 2}`, rows.slice(i, i + CHUNK));
  }

  // Blank whatever the previous run left below the new data. Without a known
  // previous count, clear generously — an over-wide clear costs one request,
  // while an under-wide one leaves last week's rows masquerading as this
  // week's.
  const staleFrom = rows.length + 2;
  const staleTo = Math.max(previous, rows.length + 2);
  if (staleTo >= staleFrom) {
    const response = await sheetsFetch(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/`
      + `${encodeURIComponent(`${quoted}!A${staleFrom}:ZZ${staleTo}`)}:clear`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );
    // A clear that fails on a range past the end of the grid is harmless —
    // there was nothing there to blank.
    if (!response.ok && response.status !== 400) {
      const body = await response.text().catch(() => "");
      throw new Error(`Clearing stale rows of "${sheetName}" failed (${response.status}): ${body}`);
    }
  }

  return rows.length;
}

/**
 * Widens a tab's grid so `values.update` has somewhere to write.
 *
 * Only ever grows. Shrinking would delete cells — and with them any formula
 * or pivot a human put to the right of the exported columns.
 */
async function ensureGrid(
  token: string,
  spreadsheetId: string,
  sheetName: string,
  minRows: number,
  minCols: number,
  known?: TabMeta[],
): Promise<number> {
  let tab = known?.find((t) => t.title === sheetName);
  if (!tab) {
    // Not in the caller's snapshot: either none was passed, or this tab was
    // created after it was taken. One extra read, only in that case.
    const metaResponse = await sheetsFetch(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}`
      + `?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!metaResponse.ok) {
      throw new Error(`Could not read the spreadsheet grid (${metaResponse.status}).`);
    }
    const meta = (await metaResponse.json()) as {
      sheets?: {
        properties?: {
          sheetId?: number;
          title?: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
    };
    const props = (meta.sheets ?? []).find((x) => x.properties?.title === sheetName)?.properties;
    if (!props || props.sheetId == null) throw new Error(`No tab named "${sheetName}".`);
    tab = {
      sheetId: props.sheetId,
      title: sheetName,
      rowCount: props.gridProperties?.rowCount ?? 0,
      columnCount: props.gridProperties?.columnCount ?? 0,
    };
  }

  const { rowCount, columnCount } = tab;
  if (rowCount >= minRows && columnCount >= minCols) return rowCount;

  const response = await sheetsFetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: tab.sheetId,
              gridProperties: {
                rowCount: Math.max(rowCount, minRows),
                columnCount: Math.max(columnCount, minCols),
              },
            },
            fields: "gridProperties.rowCount,gridProperties.columnCount",
          },
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Could not resize "${sheetName}" (${response.status}): ${body}`);
  }
  return rowCount;
}
