// Unit tests for src/lib/google/calendar.ts's calendarList pagination and
// retry/backoff, proving the reference-repo bug (calendarList.list() with no
// pageToken loop) is fixed and that quota errors are retried without any
// real Google account or network access. `fetch` is fully mocked; the
// service-account signing still runs for real against a throwaway RSA key so
// getGoogleAccessToken()'s WebCrypto path is exercised too.

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleCalendarClient,
  GoogleCalendarError,
  listAllCalendars,
  type GoogleServiceAccount,
} from "../src/lib/google/calendar";

function makeServiceAccount(): GoogleServiceAccount {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    client_email: "test-sync@example.iam.gserviceaccount.com",
    private_key: privateKey as unknown as string,
    token_uri: "https://fake-token.example/token",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isTokenRequest(url: string): boolean {
  return url.includes("fake-token.example");
}

describe("GoogleCalendarClient", () => {
  const serviceAccount = makeServiceAccount();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("listAllCalendars pages through nextPageToken until exhausted", async () => {
    const calendarListCalls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (isTokenRequest(target)) return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
      calendarListCalls.push(target);
      if (!target.includes("pageToken")) {
        return jsonResponse({ items: [{ id: "cal-1", summary: "School A" }], nextPageToken: "page-2" });
      }
      return jsonResponse({ items: [{ id: "cal-2", summary: "School B" }] });
    });

    const client = new GoogleCalendarClient(serviceAccount);
    const calendars = await listAllCalendars(client);

    expect(calendars).toEqual([
      { id: "cal-1", summary: "School A" },
      { id: "cal-2", summary: "School B" },
    ]);
    expect(calendarListCalls).toHaveLength(2);
  });

  it("retries a 500 with backoff and eventually succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (isTokenRequest(target)) return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
      attempts += 1;
      if (attempts < 3) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({ items: [{ id: "cal-1" }] });
    });

    const client = new GoogleCalendarClient(serviceAccount);
    const resultPromise = client.listCalendars();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(attempts).toBe(3);
    expect(result.items).toEqual([{ id: "cal-1" }]);
  });

  it("retries a rate-limited 403 but not a permissions 403", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (isTokenRequest(target)) return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", errors: [{ reason: "rateLimitExceeded" }] } }, 403);
      }
      return jsonResponse({ items: [] });
    });

    const client = new GoogleCalendarClient(serviceAccount);
    const resultPromise = client.listCalendars();
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(attempts).toBe(2);

    attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (isTokenRequest(target)) return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
      attempts += 1;
      return jsonResponse({ error: { errors: [{ reason: "forbidden" }] } }, 403);
    });
    await expect(client.listCalendars()).rejects.toThrow(GoogleCalendarError);
    expect(attempts).toBe(1);
  });

  it("does not retry a plain 404 and throws immediately", async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (isTokenRequest(target)) return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
      attempts += 1;
      return jsonResponse({ error: "not found" }, 404);
    });

    const client = new GoogleCalendarClient(serviceAccount);
    await expect(client.listCalendars()).rejects.toThrow(GoogleCalendarError);
    expect(attempts).toBe(1);
  });

  it("gives up after the retry ceiling and throws", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (isTokenRequest(target)) return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
      attempts += 1;
      return jsonResponse({ error: "boom" }, 500);
    });

    const client = new GoogleCalendarClient(serviceAccount);
    const resultPromise = client.listCalendars().catch((error) => error);
    await vi.runAllTimersAsync();
    const error = await resultPromise;

    expect(error).toBeInstanceOf(GoogleCalendarError);
    expect(attempts).toBe(5);
  });
});
