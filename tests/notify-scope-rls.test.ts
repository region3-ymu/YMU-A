// Hosted integration test for the review's L6 fix (migration 0019): a Regional
// Manager may read only notification_queue rows whose payload school_id
// resolves to a school in their own region — not every row cross-region, as
// 0018 allowed. OM/CPO still see all rows; every user still sees their own.
// Same disposable-user pattern as the other RLS suites.

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

describe.runIf(configured)("notification_queue RM region scope (review L6)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdQueueIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `notify-scope-rls-${randomUUID()}@example.com`;
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

  async function createSchool(region: string): Promise<string> {
    const { data, error } = await admin
      .from("schools")
      .insert({ name: `Notify Scope ${region} ${randomUUID()}`, address: "addr", region, lat: 25.7, lng: -80.1, geofence_radius_m: 200 })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createSchool failed: ${error?.message}`);
    createdSchoolIds.push(data.id);
    return data.id;
  }

  async function enqueue(recipientId: string, schoolId: string): Promise<string> {
    const { data, error } = await admin
      .from("notification_queue")
      .insert({ recipient_id: recipientId, type: "late_clock_in", payload: { school_id: schoolId } })
      .select("id")
      .single();
    if (error || !data) throw new Error(`enqueue failed: ${error?.message}`);
    createdQueueIds.push(data.id);
    return data.id;
  }

  let rmCentral: TestUser;
  let om: TestUser;
  let recipient: TestUser; // a teacher who is the recipient, so RM access is NOT via the own-row branch
  let centralRowId: string;
  let eastRowId: string;

  beforeAll(async () => {
    [rmCentral, om, recipient] = await Promise.all([
      createUser("RM Central"),
      createUser("Operations Manager"),
      createUser("Recipient Teacher"),
    ]);
    await Promise.all([
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(om.id, "operations_manager"),
    ]);
    const [centralSchool, eastSchool] = await Promise.all([createSchool("central"), createSchool("east")]);
    centralRowId = await enqueue(recipient.id, centralSchool);
    eastRowId = await enqueue(recipient.id, eastSchool);
  }, 60_000);

  afterAll(async () => {
    if (createdQueueIds.length) await admin.from("notification_queue").delete().in("id", createdQueueIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("a regional manager sees a queue row for their own region, not another region's", async () => {
    const { data } = await rmCentral.client
      .from("notification_queue")
      .select("id")
      .in("id", [centralRowId, eastRowId]);
    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(centralRowId);
    expect(ids).not.toContain(eastRowId);
  });

  it("an operations manager sees both regions' rows", async () => {
    const { data } = await om.client
      .from("notification_queue")
      .select("id")
      .in("id", [centralRowId, eastRowId]);
    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(centralRowId);
    expect(ids).toContain(eastRowId);
  });
});
