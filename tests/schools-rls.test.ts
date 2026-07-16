// Integration tests for schools/school_years RLS and the teacher_directory()
// RPC, run against the HOSTED Supabase project (same approach as
// tests/rls.test.ts — no local Docker stack on this machine).
//
//   npm run test:rls
//
// Creates throwaway confirmed users via the service-role admin API, signs in
// as them with the anon key, and asserts the Phase 2 region-immutability
// matrix. All users and any schools/school_years rows created here are
// deleted afterwards.

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
    "Skipping schools RLS tests: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not set.",
  );
}

const PASSWORD = "rls-test-password-1!";

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("schools & school_years RLS", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdSchoolYearIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `schools-rls-${randomUUID()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName, phone: "+1 305 555 0100" },
    });
    if (error || !data.user) {
      throw new Error(`createUser failed: ${error?.message}`);
    }
    createdUserIds.push(data.user.id);

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

  async function setRole(id: string, role: string, region: string | null = null) {
    const { error } = await admin.from("profiles").update({ role, region }).eq("id", id);
    if (error) throw new Error(`setRole failed: ${error.message}`);
  }

  let teacherA: TestUser; // no region
  let teacherCentral: TestUser;
  let teacherEast: TestUser;
  let rmCentral: TestUser;
  let rmEast: TestUser;
  let om: TestUser;

  beforeAll(async () => {
    [teacherA, teacherCentral, teacherEast, rmCentral, rmEast, om] = await Promise.all([
      createUser("Teacher A"),
      createUser("Teacher Central"),
      createUser("Teacher East"),
      createUser("RM Central"),
      createUser("RM East"),
      createUser("Operations Manager"),
    ]);
    await Promise.all([
      setRole(teacherCentral.id, "teacher", "central"),
      setRole(teacherEast.id, "teacher", "east"),
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(rmEast.id, "regional_manager", "east"),
      setRole(om.id, "operations_manager"),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (createdSchoolIds.length) {
      await admin.from("schools").delete().in("id", createdSchoolIds);
    }
    if (createdSchoolYearIds.length) {
      await admin.from("school_years").delete().in("id", createdSchoolYearIds);
    }
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("a regional manager can add a school, left unassigned", async () => {
    const { data, error } = await rmCentral.client
      .from("schools")
      .insert({ name: "RM Find Elementary", address: "1 RM Way, Miami, FL" })
      .select("id, region")
      .single();
    expect(error).toBeNull();
    expect(data?.region).toBeNull();
    if (data) createdSchoolIds.push(data.id);
  });

  it("a regional manager cannot add a school with a region set", async () => {
    const { error } = await rmCentral.client
      .from("schools")
      .insert({ name: "Sneaky Elementary", address: "2 RM Way, Miami, FL", region: "central" });
    expect(error).not.toBeNull();
  });

  it("an operations manager can add a school with a region set directly", async () => {
    const { data, error } = await om.client
      .from("schools")
      .insert({ name: "OM Central Elementary", address: "3 OM Way, Miami, FL", region: "central" })
      .select("id")
      .single();
    expect(error).toBeNull();
    if (data) createdSchoolIds.push(data.id);
  });

  it("a teacher cannot read or write the schools table at all", async () => {
    const { data: readData } = await teacherA.client.from("schools").select("id");
    expect(readData ?? []).toHaveLength(0);

    const { error: writeError } = await teacherA.client
      .from("schools")
      .insert({ name: "Teacher Snuck In", address: "nowhere" });
    expect(writeError).not.toBeNull();
  });

  describe("region immutability", () => {
    let schoolId: string;

    beforeAll(async () => {
      const { data, error } = await om.client
        .from("schools")
        .insert({ name: "Immutability Test School", address: "4 Test Ave, Miami, FL" })
        .select("id")
        .single();
      if (error || !data) throw new Error(`setup insert failed: ${error?.message}`);
      schoolId = data.id;
      createdSchoolIds.push(schoolId);
    });

    it("an operations manager can assign a region", async () => {
      const { error } = await om.client
        .from("schools")
        .update({ region: "central" })
        .eq("id", schoolId);
      expect(error).toBeNull();

      const { data } = await om.client.from("schools").select("region").eq("id", schoolId).single();
      expect(data?.region).toBe("central");
    });

    it("a regional manager cannot change the region once set, even in-region", async () => {
      const { error } = await rmCentral.client
        .from("schools")
        .update({ region: "east" })
        .eq("id", schoolId);
      expect(error).not.toBeNull();

      const { data } = await om.client.from("schools").select("region").eq("id", schoolId).single();
      expect(data?.region).toBe("central"); // unchanged
    });

    it("a regional manager CAN still update non-region columns on that school", async () => {
      const { error } = await rmCentral.client
        .from("schools")
        .update({ contact_name: "Front Office" })
        .eq("id", schoolId);
      expect(error).toBeNull();
    });

    it("an operations manager can change the region again", async () => {
      const { error } = await om.client
        .from("schools")
        .update({ region: "east" })
        .eq("id", schoolId);
      expect(error).toBeNull();

      const { data } = await om.client.from("schools").select("region").eq("id", schoolId).single();
      expect(data?.region).toBe("east");
    });
  });

  describe("region-scoped visibility", () => {
    let centralId: string;
    let eastId: string;
    let unassignedId: string;

    beforeAll(async () => {
      const [central, east, unassigned] = await Promise.all([
        om.client
          .from("schools")
          .insert({ name: "Visibility Central", address: "5 Test Ave", region: "central" })
          .select("id")
          .single(),
        om.client
          .from("schools")
          .insert({ name: "Visibility East", address: "6 Test Ave", region: "east" })
          .select("id")
          .single(),
        om.client
          .from("schools")
          .insert({ name: "Visibility Unassigned", address: "7 Test Ave" })
          .select("id")
          .single(),
      ]);
      if (central.error || east.error || unassigned.error) {
        throw new Error("visibility setup failed");
      }
      centralId = central.data!.id;
      eastId = east.data!.id;
      unassignedId = unassigned.data!.id;
      createdSchoolIds.push(centralId, eastId, unassignedId);
    });

    it("a regional manager sees their region plus unassigned schools, not other regions", async () => {
      const { data } = await rmCentral.client.from("schools").select("id");
      const ids = (data ?? []).map((row) => row.id);
      expect(ids).toContain(centralId);
      expect(ids).toContain(unassignedId);
      expect(ids).not.toContain(eastId);
    });

    it("an operations manager sees every school regardless of region", async () => {
      const { data } = await om.client.from("schools").select("id");
      const ids = (data ?? []).map((row) => row.id);
      expect(ids).toContain(centralId);
      expect(ids).toContain(eastId);
      expect(ids).toContain(unassignedId);
    });
  });

  describe("teacher_directory()", () => {
    it("a teacher gets nothing back", async () => {
      const { data, error } = await teacherA.client.rpc("teacher_directory");
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("a regional manager gets only teachers in their own region, with email", async () => {
      const { data, error } = await rmCentral.client.rpc("teacher_directory");
      expect(error).toBeNull();
      const ids = (data ?? []).map((row: { id: string }) => row.id);
      expect(ids).toContain(teacherCentral.id);
      expect(ids).not.toContain(teacherEast.id);
      expect(ids).not.toContain(teacherA.id);
      const row = (data ?? []).find((r: { id: string }) => r.id === teacherCentral.id);
      expect(row?.email).toBe(teacherCentral.email);
    });

    it("an operations manager gets every teacher, including region-less ones", async () => {
      const { data, error } = await om.client.rpc("teacher_directory");
      expect(error).toBeNull();
      const ids = (data ?? []).map((row: { id: string }) => row.id);
      expect(ids).toContain(teacherA.id);
      expect(ids).toContain(teacherCentral.id);
      expect(ids).toContain(teacherEast.id);
    });
  });

  describe("school_years", () => {
    it("a regional manager cannot create a school year", async () => {
      const { error } = await rmCentral.client
        .from("school_years")
        .insert({ name: "2026-27", start_date: "2026-08-01", end_date: "2027-06-01" });
      expect(error).not.toBeNull();
    });

    it("an operations manager can create a school year, and a regional manager can read it", async () => {
      const { data, error } = await om.client
        .from("school_years")
        .insert({ name: "2026-27 Test", start_date: "2026-08-01", end_date: "2027-06-01" })
        .select("id")
        .single();
      expect(error).toBeNull();
      if (data) createdSchoolYearIds.push(data.id);

      const { data: rmView } = await rmCentral.client
        .from("school_years")
        .select("id")
        .eq("id", data!.id);
      expect(rmView).toHaveLength(1);
    });

    it("a teacher cannot read school_years", async () => {
      const { data } = await teacherA.client.from("school_years").select("id");
      expect(data ?? []).toHaveLength(0);
    });
  });
});
