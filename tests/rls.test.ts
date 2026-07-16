// Integration tests for profiles RLS, run against the HOSTED Supabase project
// (this machine has no Docker for a local stack). Reads credentials from
// .env.local; skips with a notice when they're absent (e.g. CI).
//
//   npm run test:rls
//
// Creates throwaway confirmed users via the service-role admin API, signs in
// as them with the anon key, and asserts the Phase 1 role matrix. All users
// are deleted afterwards.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // No .env.local — rely on the ambient environment.
  }
}

loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

if (!configured) {
  console.warn(
    "Skipping RLS tests: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not set.",
  );
}

const PASSWORD = "rls-test-password-1!";

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("profiles RLS", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `rls-${randomUUID()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName, phone: "+1 305 555 0100" },
    });
    if (error || !data.user) {
      throw new Error(`createUser failed: ${error?.message}`);
    }
    createdIds.push(data.user.id);

    const client = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    if (signInError) {
      throw new Error(`signIn failed: ${signInError.message}`);
    }
    return { id: data.user.id, email, client };
  }

  // Service-role setup shortcut (bypasses RLS; the privileged-columns trigger
  // deliberately lets JWT-less sessions through).
  async function setRole(
    id: string,
    role: string,
    region: string | null = null,
  ) {
    const { error } = await admin
      .from("profiles")
      .update({ role, region })
      .eq("id", id);
    if (error) throw new Error(`setRole failed: ${error.message}`);
  }

  let teacherA: TestUser;
  let teacherB: TestUser;
  let teacherCentral: TestUser;
  let teacherEast: TestUser;
  let rmCentral: TestUser;
  let om: TestUser;

  beforeAll(async () => {
    [teacherA, teacherB, teacherCentral, teacherEast, rmCentral, om] =
      await Promise.all([
        createUser("Teacher A"),
        createUser("Teacher B"),
        createUser("Teacher Central"),
        createUser("Teacher East"),
        createUser("RM Central"),
        createUser("Operations Manager"),
      ]);
    await Promise.all([
      setRole(teacherCentral.id, "teacher", "central"),
      setRole(teacherEast.id, "teacher", "east"),
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(om.id, "operations_manager"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(
      createdIds.map((id) => admin.auth.admin.deleteUser(id)),
    );
  }, 60_000);

  it("signup trigger creates a teacher profile with the signup metadata", async () => {
    const { data, error } = await teacherA.client
      .from("profiles")
      .select("full_name, phone, role, region, archived_at")
      .eq("id", teacherA.id)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      full_name: "Teacher A",
      role: "teacher",
      region: null,
      archived_at: null,
    });
  });

  it("a teacher sees exactly one profiles row: their own", async () => {
    const { data, error } = await teacherA.client.from("profiles").select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(teacherA.id);
  });

  it("a teacher cannot read another teacher's row, even by id", async () => {
    const { data, error } = await teacherA.client
      .from("profiles")
      .select("id")
      .eq("id", teacherB.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("a signed-out (anon) client can read nothing", async () => {
    const anon = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await anon.from("profiles").select("id");
    expect(data ?? []).toHaveLength(0);
  });

  it("a teacher can update their own contact fields", async () => {
    const { error } = await teacherA.client
      .from("profiles")
      .update({ phone: "+1 305 555 0199", subjects: ["guitar"] })
      .eq("id", teacherA.id);
    expect(error).toBeNull();
  });

  it("a teacher cannot change their own role, region, or archived status", async () => {
    for (const patch of [
      { role: "cpo" },
      { region: "central" },
      { archived_at: new Date().toISOString() },
    ]) {
      const { error } = await teacherA.client
        .from("profiles")
        .update(patch)
        .eq("id", teacherA.id);
      expect(error, `expected ${JSON.stringify(patch)} to be rejected`).not.toBeNull();
    }
  });

  it("a teacher cannot call promote_user", async () => {
    const { error } = await teacherA.client.rpc("promote_user", {
      target_id: teacherB.id,
      new_role: "regional_manager",
      new_region: "central",
    });
    expect(error).not.toBeNull();
  });

  it("a regional manager sees their region plus themselves — nothing else", async () => {
    const { data, error } = await rmCentral.client.from("profiles").select("id");
    expect(error).toBeNull();
    const ids = (data ?? []).map((row) => row.id);
    expect(ids).toContain(rmCentral.id);
    expect(ids).toContain(teacherCentral.id);
    expect(ids).not.toContain(teacherEast.id);
    expect(ids).not.toContain(teacherA.id); // region-less teacher
  });

  it("a regional manager cannot call promote_user", async () => {
    const { error } = await rmCentral.client.rpc("promote_user", {
      target_id: teacherCentral.id,
      new_role: "regional_manager",
      new_region: "central",
    });
    expect(error).not.toBeNull();
  });

  it("an operations manager sees every profile", async () => {
    const { data, error } = await om.client.from("profiles").select("id");
    expect(error).toBeNull();
    const ids = (data ?? []).map((row) => row.id);
    for (const user of [teacherA, teacherB, teacherCentral, teacherEast, rmCentral, om]) {
      expect(ids).toContain(user.id);
    }
  });

  it("an operations manager can promote a teacher to regional manager (with region)", async () => {
    const { error } = await om.client.rpc("promote_user", {
      target_id: teacherB.id,
      new_role: "regional_manager",
      new_region: "east",
    });
    expect(error).toBeNull();

    const { data } = await om.client
      .from("profiles")
      .select("role, region")
      .eq("id", teacherB.id)
      .single();
    expect(data).toMatchObject({ role: "regional_manager", region: "east" });

    // Demote back; region must clear.
    const { error: demoteError } = await om.client.rpc("promote_user", {
      target_id: teacherB.id,
      new_role: "teacher",
    });
    expect(demoteError).toBeNull();
    const { data: after } = await om.client
      .from("profiles")
      .select("role, region")
      .eq("id", teacherB.id)
      .single();
    expect(after).toMatchObject({ role: "teacher", region: null });
  });

  it("promoting to regional manager without a region is rejected", async () => {
    const { error } = await om.client.rpc("promote_user", {
      target_id: teacherA.id,
      new_role: "regional_manager",
    });
    expect(error).not.toBeNull();
  });

  it("an operations manager cannot appoint another operations manager (CPO only)", async () => {
    const { error } = await om.client.rpc("promote_user", {
      target_id: teacherA.id,
      new_role: "operations_manager",
    });
    expect(error).not.toBeNull();
  });

  it("nobody can be promoted to cpo through the RPC", async () => {
    const { error } = await om.client.rpc("promote_user", {
      target_id: teacherA.id,
      new_role: "cpo",
    });
    expect(error).not.toBeNull();
  });

  it("an operations manager cannot change another operations manager's role", async () => {
    const om2 = await createUser("Second OM");
    await setRole(om2.id, "operations_manager");
    const { error } = await om.client.rpc("promote_user", {
      target_id: om2.id,
      new_role: "teacher",
    });
    expect(error).not.toBeNull();
  });

  it("an archived teacher's row shows archived_at (gate is enforced in the app layer)", async () => {
    await admin
      .from("profiles")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", teacherEast.id);
    const { data } = await teacherEast.client
      .from("profiles")
      .select("archived_at")
      .eq("id", teacherEast.id)
      .single();
    expect(data?.archived_at).not.toBeNull();
  });
});
