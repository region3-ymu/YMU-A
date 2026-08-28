// Who may administer accounts at /users (migrations 0067-0069).
//
// The TS guard decides whether the page renders; these are the SQL checks
// behind it — promote_user()'s caller gate, profiles_update_admin, and the
// protect_privileged_profile_columns trigger. All three used to spell out
// (operations_manager, cpo) separately, which is why they get tested together:
// the failure mode is one of them moving without the others.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInWithRetry } from "./rls-test-accounts";

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

describe.runIf(configured)("team administration", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];

  let administrator: TestUser;
  let academic: TestUser;
  let plainRm: TestUser;   // regional_manager, no is_app_admin — must be refused
  let flaggedRm: TestUser; // regional_manager + is_app_admin — the bridge
  let target: TestUser;    // a teacher for everyone to aim at

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `team-rls-${randomUUID()}@example.com`;
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
    await signInWithRetry(client, email, PASSWORD);
    return { id: data.user.id, email, client };
  }

  beforeAll(async () => {
    [administrator, academic, plainRm, flaggedRm, target] = await Promise.all([
      createUser("Team Suite Administrator"),
      createUser("Team Suite Academic"),
      createUser("Team Suite Plain RM"),
      createUser("Team Suite Flagged RM"),
      createUser("Team Suite Target"),
    ]);

    await admin.from("profiles").update({ role: "administrator" }).eq("id", administrator.id);
    await admin.from("profiles").update({ role: "academic_manager" }).eq("id", academic.id);
    await admin.from("profiles").update({ role: "regional_manager", region: "central" }).eq("id", plainRm.id);
    await admin
      .from("profiles")
      .update({ role: "regional_manager", region: "central", is_app_admin: true })
      .eq("id", flaggedRm.id);
  }, 60_000);

  afterAll(async () => {
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  }, 60_000);

  async function currentRole(id: string) {
    const { data } = await admin.from("profiles").select("role").eq("id", id).single();
    return data?.role as string | undefined;
  }

  async function resetTarget() {
    await admin.from("profiles").update({ role: "teacher", region: null }).eq("id", target.id);
  }

  describe("promote_user caller gate", () => {
    it("lets an administrator change a role", async () => {
      await resetTarget();
      const { error } = await administrator.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "afterschool_manager",
        new_region: null,
      });
      expect(error).toBeNull();
      expect(await currentRole(target.id)).toBe("afterschool_manager");
    });

    // 0074: an Academic Manager runs the roster but does not decide who is a
    // manager. Assigning 'teacher' is the only role change left to them.
    it("refuses an academic manager a manager role", async () => {
      await resetTarget();
      const { error } = await academic.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "regional_manager",
        new_region: "south",
      });
      expect(error?.message ?? "").toMatch(/CPO or an administrator/i);
      expect(await currentRole(target.id)).toBe("teacher");
    });

    it("refuses a plain regional manager", async () => {
      await resetTarget();
      const { error } = await plainRm.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "regional_manager",
        new_region: "central",
      });
      expect(error?.message ?? "").toMatch(/team administrator/i);
      expect(await currentRole(target.id)).toBe("teacher");
    });

    // The bridge in 0069 gets the app admin INTO Team, and that is all it does.
    // Since 0074 it does not carry the manager-role power, so region3@ymu.org
    // cannot appoint anyone while it is still a regional_manager + is_app_admin
    // — it needs the administrator role for that. Delete this test with the
    // bridge.
    it("lets the app admin into Team but not into appointing managers", async () => {
      await resetTarget();
      const { error: teacherChange } = await flaggedRm.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "teacher",
        new_region: null,
      });
      expect(teacherChange).toBeNull();

      const { error: managerChange } = await flaggedRm.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "afterschool_manager",
        new_region: null,
      });
      expect(managerChange?.message ?? "").toMatch(/CPO or an administrator/i);
      expect(await currentRole(target.id)).toBe("teacher");
    });
  });

  describe("target protections, unchanged", () => {
    it("never assigns the CPO role", async () => {
      await resetTarget();
      const { error } = await administrator.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "cpo",
        new_region: null,
      });
      expect(error?.message ?? "").toMatch(/CPO role can only be assigned manually/i);
    });

    it("requires a region for a Regional Manager", async () => {
      await resetTarget();
      const { error } = await administrator.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "regional_manager",
        new_region: null,
      });
      expect(error?.message ?? "").toMatch(/region is required/i);
      expect(await currentRole(target.id)).toBe("teacher");
    });

    // Was "administrator yes, academic manager no". 0072 made the four org-wide
    // roles identical (YMU 2026-08-18), so there is no longer a reason for one
    // to out-rank another — current_can_assign_operations_manager() is just
    // current_sees_all_regions() now.
    it("lets an administrator hand out Operations Manager, and refuses an academic manager", async () => {
      await resetTarget();
      const { error: asAdministrator } = await administrator.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "operations_manager",
        new_region: null,
      });
      expect(asAdministrator).toBeNull();

      await resetTarget();
      const { error: asAcademic } = await academic.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "operations_manager",
        new_region: null,
      });
      expect(asAcademic?.message ?? "").toMatch(/CPO or an administrator/i);
    });

    // Taking a role away is gated exactly like giving one out: demoting a
    // Regional Manager is as consequential as appointing one.
    it("refuses an academic manager the demotion of an existing manager", async () => {
      await resetTarget();
      await admin.from("profiles").update({ role: "afterschool_manager" }).eq("id", target.id);
      const { error } = await academic.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "teacher",
        new_region: null,
      });
      expect(error?.message ?? "").toMatch(/CPO or an administrator/i);
      expect(await currentRole(target.id)).toBe("afterschool_manager");
    });

    it("still refuses a plain regional manager that promotion", async () => {
      await resetTarget();
      const { error } = await plainRm.client.rpc("promote_user", {
        target_id: target.id,
        new_role: "operations_manager",
        new_region: null,
      });
      expect(error?.message ?? "").toMatch(/team administrator/i);
      expect(await currentRole(target.id)).toBe("teacher");
    });
  });

  describe("the column trigger, for anything that bypasses promote_user", () => {
    it("stops a teacher handing themselves a role through profiles_update_own", async () => {
      await resetTarget();
      const { error } = await target.client
        .from("profiles")
        .update({ role: "administrator" })
        .eq("id", target.id);
      expect(error?.message ?? "").toMatch(/requires a team administrator/i);
      expect(await currentRole(target.id)).toBe("teacher");
    });

    it("lets an administrator archive somebody", async () => {
      await resetTarget();
      const { error } = await administrator.client
        .from("profiles")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", target.id);
      expect(error).toBeNull();
      await admin.from("profiles").update({ archived_at: null }).eq("id", target.id);
    });

    it("refuses a plain regional manager the same archive", async () => {
      await resetTarget();
      const { error } = await plainRm.client
        .from("profiles")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", target.id);
      // profiles_update_admin gives no rows to update, so this is either a
      // policy refusal or a silent zero-row write — never an actual archive.
      const { data } = await admin
        .from("profiles")
        .select("archived_at")
        .eq("id", target.id)
        .single();
      expect(data?.archived_at ?? null).toBeNull();
      expect(error === null || /requires a team administrator/i.test(error.message)).toBe(true);
    });
  });
});
