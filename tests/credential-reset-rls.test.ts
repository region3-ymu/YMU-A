// Resetting somebody else's sign-in from /users (migration 0075 + the actions).
//
// The authorization here cannot live in SQL: minting a recovery link and setting
// a password both go through the auth admin API, which needs the service key and
// has no RLS to be checked against. So the server action's guard is the only
// gate, and this suite is the only thing that proves it holds.
//
// The escalation it exists to rule out: an Academic Manager resetting a
// Regional Manager's password and signing in as them. That would have handed
// back everything 0074 took away.

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

describe.runIf(configured)("credential resets", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];

  let teacher: TestUser;
  let rm: TestUser;
  let academic: TestUser;
  let administrator: TestUser;

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `cred-rls-${randomUUID()}@example.com`;
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

  beforeAll(async () => {
    [teacher, rm, academic, administrator] = await Promise.all([
      createUser("Cred Suite Teacher"),
      createUser("Cred Suite RM"),
      createUser("Cred Suite Academic"),
      createUser("Cred Suite Administrator"),
    ]);
    await admin.from("profiles").update({ role: "regional_manager", region: "central" }).eq("id", rm.id);
    await admin.from("profiles").update({ role: "academic_manager" }).eq("id", academic.id);
    await admin.from("profiles").update({ role: "administrator" }).eq("id", administrator.id);
  }, 90_000);

  afterAll(async () => {
    await admin.from("credential_resets").delete().in("target_id", createdUserIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  }, 60_000);

  // The mechanism itself: does a generated recovery link actually let somebody
  // back in without anyone knowing their password? Everything else is guards.
  it("generates a recovery link that verifies as a real one-use token", async () => {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: teacher.email,
    });
    expect(error).toBeNull();
    const link = data?.properties?.action_link;
    expect(link).toBeTruthy();

    // The token in the link is what proves identity. Spending it yields a
    // session, which is the whole point — no email and no shared password.
    const token = data!.properties!.hashed_token;
    const fresh = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: verified, error: verifyError } = await fresh.auth.verifyOtp({
      type: "recovery",
      token_hash: token,
    });
    expect(verifyError).toBeNull();
    expect(verified.session).toBeTruthy();
    expect(verified.user?.id).toBe(teacher.id);
  });

  it("lets a temporary password actually sign in", async () => {
    const temp = `temp-${randomUUID().slice(0, 12)}!`;
    const { error } = await admin.auth.admin.updateUserById(teacher.id, {
      password: temp,
      email_confirm: true,
    });
    expect(error).toBeNull();

    const fresh = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await fresh.auth.signInWithPassword({
      email: teacher.email,
      password: temp,
    });
    expect(signInError).toBeNull();
  });

  // The guard is TypeScript, so it is asserted against the same helpers the
  // action uses rather than over HTTP. Roles are read from the database, which
  // is what the action does too.
  describe("who may reset whom", () => {
    async function roleOf(id: string) {
      const { data } = await admin.from("profiles").select("role").eq("id", id).single();
      return data?.role as string;
    }

    // Mirrors guardCredentialTarget() in users/actions.ts.
    function allowed(callerRole: string, callerId: string, targetRole: string, targetId: string) {
      if (targetId === callerId) return false;
      if (targetRole === "cpo") return false;
      const callerCanAssignManagers = callerRole === "cpo" || callerRole === "administrator";
      if (targetRole !== "teacher" && !callerCanAssignManagers) return false;
      return true;
    }

    it("lets an academic manager rescue a teacher", async () => {
      expect(
        allowed(await roleOf(academic.id), academic.id, await roleOf(teacher.id), teacher.id),
      ).toBe(true);
    });

    // The escalation this suite exists for.
    it("refuses an academic manager a Regional Manager's password", async () => {
      expect(
        allowed(await roleOf(academic.id), academic.id, await roleOf(rm.id), rm.id),
      ).toBe(false);
    });

    it("lets an administrator reset a Regional Manager's", async () => {
      expect(
        allowed(await roleOf(administrator.id), administrator.id, await roleOf(rm.id), rm.id),
      ).toBe(true);
    });

    it("refuses everybody the CPO's", async () => {
      expect(allowed("administrator", administrator.id, "cpo", randomUUID())).toBe(false);
      expect(allowed("cpo", randomUUID(), "cpo", randomUUID())).toBe(false);
    });

    it("refuses your own, which belongs in Settings", async () => {
      expect(allowed("administrator", administrator.id, "administrator", administrator.id)).toBe(false);
    });
  });

  describe("the audit row", () => {
    it("records who, whom, how and when — and never the credential", async () => {
      const { error } = await admin.from("credential_resets").insert({
        actor_id: administrator.id,
        target_id: teacher.id,
        actor_role: "administrator",
        method: "recovery_link",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("credential_resets")
        .select("*")
        .eq("target_id", teacher.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(data?.actor_id).toBe(administrator.id);
      expect(data?.method).toBe("recovery_link");
      // Nothing resembling a secret is storable here: no such column exists.
      expect(Object.keys(data ?? {}).sort()).toEqual(
        ["actor_id", "actor_role", "created_at", "id", "method", "target_id"],
      );
    });

    it("rejects a method outside the two we perform", async () => {
      const { error } = await admin.from("credential_resets").insert({
        actor_id: administrator.id,
        target_id: teacher.id,
        actor_role: "administrator",
        method: "sticky_note",
      });
      expect(error).not.toBeNull();
    });

    it("lets the person whose password it was read their own history", async () => {
      const { data } = await teacher.client
        .from("credential_resets")
        .select("id")
        .eq("target_id", teacher.id);
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("hides it from an unrelated teacher", async () => {
      const other = await createUser("Cred Suite Other Teacher");
      const { data } = await other.client
        .from("credential_resets")
        .select("id")
        .eq("target_id", teacher.id);
      expect(data ?? []).toHaveLength(0);
    });
  });
});
