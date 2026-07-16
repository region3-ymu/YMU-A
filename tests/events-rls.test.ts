// Hosted integration tests for Phase 3 event visibility and manual matching.
// Like the Phase 1/2 suites, these create disposable confirmed users and
// clean every created row up afterwards.

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

describe.runIf(configured)("calendar event RLS", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdNotificationIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `events-rls-${randomUUID()}@example.com`;
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

  async function createSchool(name: string, region: "central" | "east") {
    const { data, error } = await admin
      .from("schools")
      .insert({ name, address: `${name} address`, region })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createSchool failed: ${error?.message}`);
    createdSchoolIds.push(data.id);
    return data.id;
  }

  async function createEvent(
    googleEventId: string,
    teacherIds: string[],
    schoolId: string | null,
  ) {
    const { data, error } = await admin
      .from("calendar_events")
      .insert({
        calendar_id: "events-rls-test-calendar",
        google_event_id: googleEventId,
        summary: googleEventId,
        location_raw: schoolId ? "Test school" : "Needs match",
        start_at: "2026-09-10T14:00:00Z",
        end_at: "2026-09-10T15:00:00Z",
        teacher_ids: teacherIds,
        school_id: schoolId,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createEvent failed: ${error?.message}`);
    createdEventIds.push(data.id);
    return data.id;
  }

  let teacherCentral: TestUser;
  let teacherEast: TestUser;
  let teacherOther: TestUser;
  let rmCentral: TestUser;
  let rmEast: TestUser;
  let om: TestUser;
  let centralSchoolId: string;
  let eastSchoolId: string;
  let otherSchoolId: string;
  let centralEventId: string;
  let eastEventId: string;
  let unmatchedEventId: string;

  beforeAll(async () => {
    [teacherCentral, teacherEast, teacherOther, rmCentral, rmEast, om] = await Promise.all([
      createUser("Teacher Central"),
      createUser("Teacher East"),
      createUser("Teacher Other"),
      createUser("RM Central"),
      createUser("RM East"),
      createUser("Operations Manager"),
    ]);
    await Promise.all([
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(rmEast.id, "regional_manager", "east"),
      setRole(om.id, "operations_manager"),
    ]);
    [centralSchoolId, eastSchoolId, otherSchoolId] = await Promise.all([
      createSchool("Event Central School", "central"),
      createSchool("Event East School", "east"),
      createSchool("Unrelated Central School", "central"),
    ]);
    [centralEventId, eastEventId, unmatchedEventId] = await Promise.all([
      createEvent("central-event", [teacherCentral.id], centralSchoolId),
      createEvent("east-event", [teacherEast.id], eastSchoolId),
      createEvent("unmatched-event", [teacherOther.id], null),
    ]);
    const { data, error } = await admin
      .from("notification_queue")
      .insert({ recipient_id: teacherCentral.id, event_id: centralEventId, type: "time_changed" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`create notification failed: ${error?.message}`);
    createdNotificationIds.push(data.id);
  }, 60_000);

  afterAll(async () => {
    if (createdNotificationIds.length) await admin.from("notification_queue").delete().in("id", createdNotificationIds);
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("teachers see only event rows whose matched attendee is their login", async () => {
    const { data } = await teacherCentral.client.from("calendar_events").select("id");
    const ids = (data ?? []).map((event) => event.id);
    expect(ids).toContain(centralEventId);
    expect(ids).not.toContain(eastEventId);
    expect(ids).not.toContain(unmatchedEventId);
  });

  it("a regional manager sees their region plus unmatched events, never another region", async () => {
    const { data } = await rmCentral.client.from("calendar_events").select("id");
    const ids = (data ?? []).map((event) => event.id);
    expect(ids).toContain(centralEventId);
    expect(ids).toContain(unmatchedEventId);
    expect(ids).not.toContain(eastEventId);
  });

  it("the other regional manager gets the inverse regional view and the shared unmatched queue", async () => {
    const { data } = await rmEast.client.from("calendar_events").select("id");
    const ids = (data ?? []).map((event) => event.id);
    expect(ids).toContain(eastEventId);
    expect(ids).toContain(unmatchedEventId);
    expect(ids).not.toContain(centralEventId);
  });

  it("an operations manager sees every event", async () => {
    const { data } = await om.client.from("calendar_events").select("id");
    const ids = (data ?? []).map((event) => event.id);
    expect(ids).toEqual(expect.arrayContaining([centralEventId, eastEventId, unmatchedEventId]));
  });

  it("a teacher can read their scheduled school but not an unrelated school", async () => {
    const { data } = await teacherCentral.client.from("schools").select("id");
    const ids = (data ?? []).map((school) => school.id);
    expect(ids).toContain(centralSchoolId);
    expect(ids).not.toContain(otherSchoolId);
    expect(ids).not.toContain(eastSchoolId);
  });

  it("a regional manager may manually assign an unmatched event to a school in their region", async () => {
    const { error } = await rmCentral.client.rpc("assign_event_school", {
      p_event_id: unmatchedEventId,
      p_school_id: centralSchoolId,
    });
    expect(error).toBeNull();
    const { data } = await om.client.from("calendar_events").select("school_id").eq("id", unmatchedEventId).single();
    expect(data?.school_id).toBe(centralSchoolId);
  });

  it("a regional manager cannot manually alter an event in another region", async () => {
    const { error } = await rmCentral.client.rpc("assign_event_school", {
      p_event_id: eastEventId,
      p_school_id: centralSchoolId,
    });
    expect(error).not.toBeNull();
  });

  it("notification_queue has no authenticated read access", async () => {
    const { data, error } = await teacherCentral.client.from("notification_queue").select("id");
    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
  });
});
