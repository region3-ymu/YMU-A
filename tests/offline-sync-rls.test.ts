// Hosted integration tests for Phase 6 offline sync: the offline-specific
// behaviour added on top of clock_in()/record_gps_check() in migration 0013 —
// the origin label, the trusted-but-clamped client clock-in time, exactly-once
// replay on client_key, record_gps_check_offline() addressing a check by
// (session client_key, due offset), and the server still re-validating the
// geofence on an offline replay. Same disposable-user pattern as the other RLS
// suites; every created row is cleaned up afterwards.

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

const SCHOOL_LAT = 25.7617;
const SCHOOL_LNG = -80.1918;
const FAR_LAT = 25.782; // ~2 km north, outside a 200 m fence
const FAR_LNG = -80.1918;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("Offline sync (Phase 6)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `offline-rls-${randomUUID()}@example.com`;
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

  async function createSchool(name: string, region: "central") {
    const { data, error } = await admin
      .from("schools")
      .insert({ name, address: `${name} address`, region, lat: SCHOOL_LAT, lng: SCHOOL_LNG, geofence_radius_m: 200 })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createSchool failed: ${error?.message}`);
    createdSchoolIds.push(data.id);
    return data.id;
  }

  async function createEvent(name: string, teacherIds: string[], schoolId: string, startAt: string) {
    const { data, error } = await admin
      .from("calendar_events")
      .insert({
        calendar_id: "offline-rls-test-calendar",
        google_event_id: `${name}-${randomUUID()}`,
        summary: name,
        start_at: startAt,
        end_at: new Date(new Date(startAt).getTime() + 3_600_000).toISOString(),
        teacher_ids: teacherIds,
        school_id: schoolId,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createEvent failed: ${error?.message}`);
    createdEventIds.push(data.id);
    return data.id;
  }

  let teacherA: TestUser; // the primary offline session (backdated, late)
  let teacherIdem: TestUser; // exactly-once replay
  let teacherFuture: TestUser; // future-time clamp
  let teacherFence: TestUser; // out-of-fence rejection
  let rmCentral: TestUser;
  let schoolId: string;
  let eventA: string;
  let eventIdem: string;
  let eventFuture: string;
  let eventFence: string;

  const sessionKeyA = randomUUID();

  beforeAll(async () => {
    [teacherA, teacherIdem, teacherFuture, teacherFence, rmCentral] = await Promise.all([
      createUser("Offline Teacher A"),
      createUser("Offline Teacher Idem"),
      createUser("Offline Teacher Future"),
      createUser("Offline Teacher Fence"),
      createUser("Offline RM Central"),
    ]);
    await setRole(rmCentral.id, "regional_manager", "central");
    schoolId = await createSchool("Offline Central School", "central");

    const now = Date.now();
    // Started 60 min ago; a clock-in 50 min ago is 10 min late.
    const startAgo = new Date(now - 60 * 60_000).toISOString();
    const startFuture = new Date(now + 60 * 60_000).toISOString();
    [eventA, eventIdem, eventFuture, eventFence] = await Promise.all([
      createEvent("offline-A", [teacherA.id], schoolId, startAgo),
      createEvent("offline-idem", [teacherIdem.id], schoolId, startFuture),
      createEvent("offline-future", [teacherFuture.id], schoolId, startFuture),
      createEvent("offline-fence", [teacherFence.id], schoolId, startFuture),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length) {
      await admin.from("flags").delete().in("teacher_id", createdUserIds);
      await admin.from("attendance_sessions").delete().in("teacher_id", createdUserIds);
    }
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("offline clock_in stamps origin='offline' and honours the client's (clamped) clock-in time", async () => {
    const clockInAt = new Date(Date.now() - 50 * 60_000).toISOString(); // 50 min ago => 10 min late
    const { data: session, error } = await teacherA.client.rpc("clock_in", {
      p_event_id: eventA,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 12,
      p_client_key: sessionKeyA,
      p_origin: "offline",
      p_clock_in_at: clockInAt,
    });
    expect(error).toBeNull();
    expect(session!.origin).toBe("offline");
    expect(session!.clock_in_status).toBe("late");
    // clock_in_at should reflect the client time (within a minute), not now().
    const drift = Math.abs(new Date(session!.clock_in_at).getTime() - new Date(clockInAt).getTime());
    expect(drift).toBeLessThan(60_000);

    // The 5 gps_checks are seeded relative to the (backdated) clock-in time, so
    // they're already in the past — exactly the offline-replay scenario.
    const { data: checks } = await admin
      .from("gps_checks")
      .select("due_at, status, origin")
      .eq("session_id", session!.id)
      .order("due_at");
    expect(checks).toHaveLength(5);
    expect(checks!.every((c) => c.status === "pending")).toBe(true);
  });

  it("replaying the same client_key returns the same session (exactly-once)", async () => {
    const key = randomUUID();
    const args = {
      p_event_id: eventIdem,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 10,
      p_client_key: key,
      p_origin: "offline",
      p_clock_in_at: new Date().toISOString(),
    };
    const first = await teacherIdem.client.rpc("clock_in", args);
    const second = await teacherIdem.client.rpc("clock_in", args);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data!.id).toBe(first.data!.id);

    const { count } = await admin
      .from("attendance_sessions")
      .select("id", { count: "exact", head: true })
      .eq("client_key", key);
    expect(count).toBe(1);
  });

  it("clamps a future client clock-in time back to no later than now", async () => {
    const oneHourAhead = new Date(Date.now() + 60 * 60_000).toISOString();
    const { data: session, error } = await teacherFuture.client.rpc("clock_in", {
      p_event_id: eventFuture,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 10,
      p_client_key: randomUUID(),
      p_origin: "offline",
      p_clock_in_at: oneHourAhead,
    });
    expect(error).toBeNull();
    // Never accept a future timestamp.
    expect(new Date(session!.clock_in_at).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("record_gps_check_offline resolves a due check as verified with origin='offline', and is idempotent", async () => {
    const { data: first, error } = await teacherA.client.rpc("record_gps_check_offline", {
      p_session_client_key: sessionKeyA,
      p_due_offset_min: 5,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 15,
      p_sampled_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
    expect(first!.status).toBe("verified");
    expect(first!.origin).toBe("offline");

    // Replaying the same sample is a no-op (still one resolved check).
    const { data: second } = await teacherA.client.rpc("record_gps_check_offline", {
      p_session_client_key: sessionKeyA,
      p_due_offset_min: 5,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 15,
      p_sampled_at: new Date().toISOString(),
    });
    expect(second!.id).toBe(first!.id);
    expect(second!.status).toBe("verified");
  });

  it("an out-of-fence offline GPS sample raises a flag tagged origin='offline'", async () => {
    const { data: check, error } = await teacherA.client.rpc("record_gps_check_offline", {
      p_session_client_key: sessionKeyA,
      p_due_offset_min: 10,
      p_lat: FAR_LAT,
      p_lng: FAR_LNG,
      p_accuracy_m: 15,
      p_sampled_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
    expect(check!.status).toBe("out_of_fence");

    const { data: flags } = await admin
      .from("flags")
      .select("type, details")
      .eq("gps_check_id", check!.id);
    expect(flags).toHaveLength(1);
    expect(flags![0].type).toBe("gps_out_of_fence");
    expect((flags![0].details as { origin?: string }).origin).toBe("offline");

    const { data: notifications } = await admin
      .from("notification_queue")
      .select("recipient_id")
      .eq("type", "gps_out_of_fence")
      .eq("recipient_id", rmCentral.id);
    expect((notifications ?? []).length).toBeGreaterThan(0);
  });

  it("still re-validates the geofence server-side on an offline clock-in (out-of-fence rejected)", async () => {
    const { error } = await teacherFence.client.rpc("clock_in", {
      p_event_id: eventFence,
      p_lat: FAR_LAT,
      p_lng: FAR_LNG,
      p_accuracy_m: 10,
      p_client_key: randomUUID(),
      p_origin: "offline",
      p_clock_in_at: new Date().toISOString(),
    });
    expect(error?.message ?? "").toMatch(/outside the .* clock-in zone/i);
  });

  it("record_gps_check_offline rejects a key that isn't the caller's own session", async () => {
    const { error } = await teacherIdem.client.rpc("record_gps_check_offline", {
      p_session_client_key: sessionKeyA, // teacherA's session, not teacherIdem's
      p_due_offset_min: 15,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 10,
      p_sampled_at: new Date().toISOString(),
    });
    expect(error?.message ?? "").toMatch(/no clock-in found/i);
  });
});
