// The bookkeeping for the throwaway accounts the RLS suites create.
//
// Those suites run against the HOSTED project — this machine has no Docker for
// a local stack — so every account one of them leaves behind is a row on the
// real Team screen, and a real recipient of every announcement's push. Between
// 18 and 21 August 2026 they left 41 of them: a CPO opening Team saw "RM
// Central" seven times and "Operations Manager" eight.
//
// Every suite marks its users the same way, an @example.com address with a
// random local part, and no real account has ever used that domain. That is
// what makes a sweep possible at all.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const TEST_EMAIL_DOMAIN = "@example.com";

/** Same loader the suites use: .env.local, without clobbering the ambient env. */
export function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // No .env.local — rely on the ambient environment.
  }
}

export function adminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type TestAccount = { id: string; email: string };

/** Every @example.com account currently in the project, paged through in full. */
export async function listTestAccounts(admin: SupabaseClient): Promise<TestAccount[]> {
  const found: TestAccount[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    for (const user of users) {
      if (user.email?.endsWith(TEST_EMAIL_DOMAIN)) found.push({ id: user.id, email: user.email });
    }
    if (users.length < 200) return found;
  }
}

/**
 * Deletes them, and says which ones would not go.
 *
 * One at a time on purpose. The suites delete with Promise.all, which fires a
 * burst of admin calls at the same auth endpoint the run has already been
 * hammering — and since every one of those calls discards its error object,
 * a cleanup that was refused looked exactly like a cleanup that worked.
 */
export async function deleteTestAccounts(
  admin: SupabaseClient,
  accounts: TestAccount[],
): Promise<{ deleted: number; failed: { email: string; message: string }[] }> {
  let deleted = 0;
  const failed: { email: string; message: string }[] = [];
  for (const account of accounts) {
    const { error } = await admin.auth.admin.deleteUser(account.id);
    if (error) failed.push({ email: account.email, message: error.message });
    else deleted += 1;
  }
  return { deleted, failed };
}

/**
 * Signs a test user in, paced and with a retry when the auth API says no.
 *
 * `signIn failed: Request rate limit reached` is what actually broke the runs
 * of 18 and 21 August 2026, and it is why all 41 orphaned accounts were still
 * `teacher` with no region: the rate limit killed the beforeAll between
 * creating the users and promoting them, so nothing downstream ever ran.
 *
 * Two things help, and neither is a cure. Sign-ins are serialised through one
 * chain with a gap between them, so a suite's `Promise.all([createUser × 6])`
 * arrives as a trickle rather than a burst; and a refusal is retried rather
 * than thrown straight up.
 *
 * The backoff is deliberately small. Every suite passes 60_000 to its
 * beforeAll, and a per-hook timeout beats anything set in the config, so there
 * is no room to wait out a window measured in minutes. If the project's
 * sign-in budget is genuinely exhausted — two full runs back to back will do
 * it — this reports that clearly and the run has to wait. The durable fixes
 * are to raise the limit for the project, or to stop minting ninety users per
 * run when a shared fixture set would need eight.
 */
let signInChain: Promise<unknown> = Promise.resolve();

export function signInWithRetry(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<void> {
  const run = signInChain.then(async () => {
    const waits = [3_000, 8_000];
    for (let attempt = 0; ; attempt += 1) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (!error) return;
      const rateLimited = error.status === 429 || /rate limit/i.test(error.message);
      if (!rateLimited || attempt >= waits.length) {
        throw new Error(
          rateLimited
            ? `signIn failed: ${error.message} — the project's auth rate limit is spent. ` +
              `A full test:rls run signs in about ninety times; wait a few minutes before running it again.`
            : `signIn failed: ${error.message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  });
  // Space the next one out, and never let a failure break the chain for
  // everybody behind it.
  signInChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 250)));
  return run;
}
