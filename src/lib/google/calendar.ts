// A small Google Calendar v3 client that works in both Next.js (Node's Web
// Crypto implementation) and Supabase Edge Functions (Deno). Keeping this
// dependency-free avoids pulling Node-only Google SDK code into the Edge
// runtime.

export type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type GoogleCalendarAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
};

export type GoogleCalendarEvent = {
  id: string;
  iCalUID?: string;
  recurringEventId?: string;
  status?: "confirmed" | "tentative" | "cancelled" | string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  updated?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GoogleCalendarAttendee[];
  [key: string]: unknown;
};

export type GoogleEventsPage = {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
};

export type GoogleCalendarListPage = {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
};

export class GoogleCalendarError extends Error {
  // Explicit fields (not constructor parameter properties) so this module is
  // erasable-syntax-only and runs under Node's native TS stripping — the local
  // runner (scripts/sync-calendar.ts) imports it directly, no build step.
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "GoogleCalendarError";
    this.status = status;
    this.body = body;
  }
}

type AccessToken = { value: string; expiresAt: number };

// calendar.readonly covers reading events/calendars/calendarList, but
// calendarList.insert (subscribeToCalendar) is a write against the
// calendarList resource -- Google rejects it under a read-only scope with
// ACCESS_TOKEN_SCOPE_INSUFFICIENT even though the caller already has real
// ACL read access to the calendar's data. calendar.calendarlist is a
// narrow, purpose-built scope that grants only calendarList membership
// writes (subscribe/unsubscribe), not event/calendar data writes -- added
// alongside calendar.readonly rather than swapping to the broad
// read-write `calendar` scope, which would over-grant event write access
// this sync never needs.
const CALENDAR_SCOPE = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist",
].join(" ");
const GOOGLE_TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

let cachedAccessToken: AccessToken | null = null;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  // Avoid spreading a large Uint8Array into String.fromCharCode, which can
  // exceed the JS engine's argument limit for service-account keys.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64Decode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemToPkcs8(pem: string): Uint8Array {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  return base64Decode(base64);
}

// TypeScript's DOM lib distinguishes ArrayBuffer from the wider
// ArrayBufferLike accepted by Uint8Array. Copying also gives WebCrypto a
// compact, transferable buffer in both Node and Deno.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function signJwt(serviceAccount: GoogleServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claims = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        iss: serviceAccount.client_email,
        scope: CALENDAR_SCOPE,
        aud: serviceAccount.token_uri ?? GOOGLE_TOKEN_AUDIENCE,
        iat: now,
        exp: now + 60 * 60,
      }),
    ),
  );
  const unsignedToken = `${header}.${claims}`;
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pemToPkcs8(serviceAccount.private_key)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    encoder.encode(unsignedToken),
  );
  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function readError(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "Unable to read Google response body.";
  }
}

const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

async function isRateLimited(response: Response): Promise<boolean> {
  // Google reports quota exhaustion as a 403 with a specific error reason,
  // not a distinct HTTP status -- a permissions 403 must not be retried.
  try {
    const body = (await response.clone().json()) as {
      error?: { errors?: Array<{ reason?: string }>; status?: string };
    };
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status;
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || reason === "RESOURCE_EXHAUSTED";
  } catch {
    return false;
  }
}

// Shared retry/backoff for calendarList and events.list, used across the 30-70
// calendars a sync run walks. Retries 429/5xx and rate-limited 403s with
// exponential backoff + jitter; leaves other 4xx alone (including a
// non-rate-limit 403), and leaves 410 alone since sync.ts special-cases it.
async function googleFetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500 || (response.status === 403 && (await isRateLimited(response)));
    if (!retryable || attempt >= RETRY_MAX_ATTEMPTS - 1) return response;

    const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
    const jitteredDelay = delay * (0.5 + Math.random() * 0.5);
    await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
  }
}

export function parseServiceAccount(base64Json: string): GoogleServiceAccount {
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(
      new TextDecoder().decode(base64Decode(base64Json.trim())),
    );
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 is not valid base64-encoded JSON.");
  }

  if (
    !serviceAccount ||
    typeof serviceAccount !== "object" ||
    typeof (serviceAccount as GoogleServiceAccount).client_email !== "string" ||
    typeof (serviceAccount as GoogleServiceAccount).private_key !== "string"
  ) {
    throw new Error("Google service-account JSON must include client_email and private_key.");
  }
  return serviceAccount as GoogleServiceAccount;
}

export async function getGoogleAccessToken(
  serviceAccount: GoogleServiceAccount,
): Promise<string> {
  // Reuse a token until it is within five minutes of expiry. The edge runtime
  // may be reused for several cron invocations, but correctness never relies
  // on that reuse.
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 5 * 60_000) {
    return cachedAccessToken.value;
  }

  const assertion = await signJwt(serviceAccount);
  const response = await fetch(serviceAccount.token_uri ?? GOOGLE_TOKEN_AUDIENCE, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    const body = await readError(response);
    throw new GoogleCalendarError(
      `Google OAuth token exchange failed (${response.status}).`,
      response.status,
      body,
    );
  }

  const token = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!token.access_token) {
    throw new Error("Google OAuth response did not include an access token.");
  }
  cachedAccessToken = {
    value: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
  return cachedAccessToken.value;
}

export type ListEventsOptions = {
  calendarId: string;
  syncToken?: string;
  pageToken?: string;
  /** Used only for the first/full sync. Omit it to import the entire calendar. */
  timeMin?: string;
};

export class GoogleCalendarClient {
  private readonly serviceAccount: GoogleServiceAccount;

  constructor(serviceAccount: GoogleServiceAccount) {
    this.serviceAccount = serviceAccount;
  }

  async listEvents(options: ListEventsOptions): Promise<GoogleEventsPage> {
    const params = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "2500",
    });
    if (options.syncToken) params.set("syncToken", options.syncToken);
    if (options.pageToken) params.set("pageToken", options.pageToken);
    // Google prohibits timeMin alongside syncToken. This conditional makes the
    // two modes impossible to accidentally mix.
    if (!options.syncToken && options.timeMin) params.set("timeMin", options.timeMin);

    const accessToken = await getGoogleAccessToken(this.serviceAccount);
    const response = await googleFetchWithRetry(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(options.calendarId)}/events?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      const body = await readError(response);
      throw new GoogleCalendarError(
        `Google Calendar events.list failed (${response.status}).`,
        response.status,
        body,
      );
    }
    return (await response.json()) as GoogleEventsPage;
  }

  async listCalendars(options: { pageToken?: string } = {}): Promise<GoogleCalendarListPage> {
    const params = new URLSearchParams({ maxResults: "250" });
    if (options.pageToken) params.set("pageToken", options.pageToken);

    const accessToken = await getGoogleAccessToken(this.serviceAccount);
    const response = await googleFetchWithRetry(
      `${GOOGLE_CALENDAR_API}/users/me/calendarList?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      const body = await readError(response);
      throw new GoogleCalendarError(
        `Google Calendar calendarList.list failed (${response.status}).`,
        response.status,
        body,
      );
    }
    return (await response.json()) as GoogleCalendarListPage;
  }

  // Google Calendar's ACL (who can access a calendar) and a given account's
  // calendarList (that account's own "list of calendars I follow") are
  // separate: sharing a calendar with the service account grants it real
  // access (events.list/etc. work immediately) but does NOT add it to the
  // service account's calendarList -- there is no UI for a service account to
  // "accept" a share the way a human would. listCalendars()/listAllCalendars()
  // above only see calendarList entries, so a newly ACL-shared calendar is
  // invisible to discovery until the service account explicitly subscribes to
  // it with this call. Idempotent: inserting an already-subscribed id is a
  // harmless no-op (409 is treated as success, matching how the Apps Script
  // bulk-share script tolerates re-granting an existing ACL rule).
  async subscribeToCalendar(calendarId: string): Promise<void> {
    const accessToken = await getGoogleAccessToken(this.serviceAccount);
    const response = await googleFetchWithRetry(`${GOOGLE_CALENDAR_API}/users/me/calendarList`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: calendarId }),
    });
    if (!response.ok && response.status !== 409) {
      const body = await readError(response);
      throw new GoogleCalendarError(
        `Google Calendar calendarList.insert failed (${response.status}) for ${calendarId}.`,
        response.status,
        body,
      );
    }
  }
}

// Pages through the full calendarList rather than trusting a single page --
// a service account subscribed to more than one page of calendars would
// otherwise silently lose the tail.
export async function listAllCalendars(
  client: GoogleCalendarClient,
): Promise<GoogleCalendarListEntry[]> {
  const entries: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.listCalendars({ pageToken });
    entries.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}
