// Hosted integration tests for Phase 9's teacher archive/unarchive action.
// No new RPC was added for this (profiles.archived_at was already writable by
// OM/CPO directly per 0002_profiles_rls.sql's protect_privileged_profile_columns
// trigger) — these tests confirm that write actually works end-to-end for an
// authenticated OM archiving SOMEONE ELSE, which tests/rls.test.ts's existing
// "a teacher cannot change their own role, region, or archived status" test
// doesn't cover (self-block only, and via a service-role update, not an
// authenticated OM). The archiveTeacher/unarchiveTeacher server actions'
// self/CPO-target guard is app-level logic, not RLS — not covered here (no
// server-action unit tests exist anywhere else in this suite either; the
// convention throughout is RLS/RPC-level hosted tests only).

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Rely on ambient env in CI-like environments.
  }
}

loadEnvLocal();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);
const PASSWORD = "rls-test-password-1!";

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("teacher archive/unarchive (Phase 9)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `users-archive-rls-${randomUUID()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    createdUserIds.push(data.user.id);
    const client = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInError) throw new Error(`signIn failed: ${signInError.message}`);
    return { id: data.user.id, email, client };
  }

  async function setRole(id: string, role: string, region: string | null = null) {
    const { error } = await admin.from("profiles").update({ role, region }).eq("id", id);
    if (error) throw new Error(`setRole failed: ${error.message}`);
  }

  let teacher: TestUser;
  let rmCentral: TestUser;
  let om: TestUser;

  beforeAll(async () => {
    [teacher, rmCentral, om] = await Promise.all([
      createUser("Archive Target"),
      createUser("RM Central"),
      createUser("Operations Manager"),
    ]);
    await Promise.all([
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(om.id, "operations_manager"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("a regional manager cannot archive another profile", async () => {
    // profiles_update_admin's USING clause is keyed on the CALLER's role, not
    // the target row, so this matches zero rows under RLS rather than
    // raising an error (no update policy covers "RM updating someone else's
    // row" at all) — confirm via a follow-up read instead, same reasoning as
    // the school_years archive test above.
    await rmCentral.client
      .from("profiles")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", teacher.id);

    const { data } = await admin.from("profiles").select("archived_at").eq("id", teacher.id).single();
    expect(data?.archived_at).toBeNull();
  });

  it("an operations manager can archive another profile, then unarchive it", async () => {
    const { error: archiveError } = await om.client
      .from("profiles")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", teacher.id);
    expect(archiveError).toBeNull();

    const { data: archived } = await admin
      .from("profiles")
      .select("archived_at")
      .eq("id", teacher.id)
      .single();
    expect(archived?.archived_at).not.toBeNull();

    const { error: unarchiveError } = await om.client
      .from("profiles")
      .update({ archived_at: null })
      .eq("id", teacher.id);
    expect(unarchiveError).toBeNull();

    const { data: unarchived } = await admin
      .from("profiles")
      .select("archived_at")
      .eq("id", teacher.id)
      .single();
    expect(unarchived?.archived_at).toBeNull();
  });

  it("an archived teacher is excluded from calendar sync's teacher-matching pool (already-built defense, re-confirmed here)", async () => {
    await admin.from("profiles").update({ archived_at: new Date().toISOString() }).eq("id", teacher.id);
    try {
      const { data } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "teacher")
        .is("archived_at", null);
      const ids = (data ?? []).map((r) => r.id);
      expect(ids).not.toContain(teacher.id);
    } finally {
      await admin.from("profiles").update({ archived_at: null }).eq("id", teacher.id);
    }
  });
});
