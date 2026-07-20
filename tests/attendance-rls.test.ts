// Hosted integration tests for Phase 4 clocking: the clock_in RPC
// (server-side geofence, on-time/late, the open-session block),
// attendance_sessions RLS, and close_session_from_zoho — the service-role-only
// function that plays the role of the Zoho feedback webhook (see
// src/app/api/zoho-feedback/route.ts and supabase/migrations/0010). Same
// disposable-user pattern as the other RLS suites; every created row is
// cleaned up afterwards.

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

// A real-ish Miami location; the "far" point is ~2 km north, well outside a
// 200 m fence.
const SCHOOL_LAT = 25.7617;
const SCHOOL_LNG = -80.1918;
const FAR_LAT = 25.782;
const FAR_LNG = -80.1918;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("attendance clocking RLS + RPCs", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `attendance-rls-${randomUUID()}@example.com`;
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
        calendar_id: "attendance-rls-test-calendar",
        google_event_id: name,
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

  let teacherA: TestUser; // future class => on_time
  let teacherB: TestUser; // past class => late
  let teacherOther: TestUser;
  let rmCentral: TestUser;
  let rmEast: TestUser;
  let om: TestUser;
  let centralSchoolId: string;
  let futureEventId: string;
  let pastEventId: string;

  beforeAll(async () => {
    [teacherA, teacherB, teacherOther, rmCentral, rmEast, om] = await Promise.all([
      createUser("Teacher A"),
      createUser("Teacher B"),
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
    // An east-region school exists so the east RM has a region to be scoped
    // to; both test sessions are at the central school, so the east RM sees
    // none of them.
    [centralSchoolId] = await Promise.all([
      createSchool("Attendance Central School", "central"),
      createSchool("Attendance East School", "east"),
    ]);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    [futureEventId, pastEventId] = await Promise.all([
      createEvent("attendance-future", [teacherA.id], centralSchoolId, future),
      createEvent("attendance-past", [teacherB.id], centralSchoolId, past),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length) await admin.from("attendance_sessions").delete().in("teacher_id", createdUserIds);
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("rejects clocking into a class you're not assigned to", async () => {
    const { error } = await teacherOther.client.rpc("clock_in", {
      p_event_id: futureEventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
    });
    expect(error?.message ?? "").toMatch(/not assigned/i);
  });

  it("rejects a clock-in outside the geofence, server-side", async () => {
    const { error } = await teacherB.client.rpc("clock_in", {
      p_event_id: pastEventId,
      p_lat: FAR_LAT,
      p_lng: FAR_LNG,
    });
    expect(error?.message ?? "").toMatch(/outside the .* clock-in zone/i);
  });

  it("allows an in-range clock-in and records on_time before the class starts", async () => {
    const { data, error } = await teacherA.client.rpc("clock_in", {
      p_event_id: futureEventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 12,
    });
    expect(error).toBeNull();
    expect(data?.clock_in_status).toBe("on_time");
    expect(data?.clock_out_at).toBeNull();
    expect(Math.round(data?.clock_in_distance_m ?? 999)).toBe(0);
  });

  it("records late when clocking in well after the scheduled start", async () => {
    const { data, error } = await teacherB.client.rpc("clock_in", {
      p_event_id: pastEventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_client_key: randomUUID(),
    });
    expect(error).toBeNull();
    expect(data?.clock_in_status).toBe("late");
  });

  it("blocks a second clock-in while a session is open (feedback owed)", async () => {
    const { error } = await teacherA.client.rpc("clock_in", {
      p_event_id: futureEventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
    });
    expect(error?.message ?? "").toMatch(/submit feedback/i);
  });

  it("teachers see only their own sessions", async () => {
    const { data: aRows } = await teacherA.client.from("attendance_sessions").select("teacher_id");
    expect((aRows ?? []).every((r) => r.teacher_id === teacherA.id)).toBe(true);
    expect((aRows ?? []).length).toBeGreaterThan(0);
  });

  it("a regional manager sees in-region sessions; the other region's RM does not", async () => {
    const { data: central } = await rmCentral.client.from("attendance_sessions").select("id");
    const { data: east } = await rmEast.client.from("attendance_sessions").select("id");
    expect((central ?? []).length).toBeGreaterThan(0);
    // Both sessions are at the central school, so the east RM sees none of them.
    expect((east ?? []).length).toBe(0);
  });

  it("an operations manager sees every session", async () => {
    const { data } = await om.client.from("attendance_sessions").select("id");
    expect((data ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("forbids a direct authenticated INSERT into attendance_sessions", async () => {
    const { error } = await teacherOther.client
      .from("attendance_sessions")
      .insert({ teacher_id: teacherOther.id, clock_in_status: "on_time" });
    expect(error).not.toBeNull();
  });

  it("a teacher's own JWT cannot call close_session_from_zoho directly", async () => {
    const { data: session } = await teacherA.client
      .from("attendance_sessions")
      .select("id")
      .is("clock_out_at", null)
      .single();
    const { error } = await teacherA.client.rpc("close_session_from_zoho", {
      p_session_id: session!.id,
      p_engagement: "Very engaged",
      p_had_issue: "No",
    });
    // Not granted to `authenticated` at all -> PostgREST reports it as missing.
    expect(error).not.toBeNull();
  });

  it("close_session_from_zoho (service-role only, called by the webhook) requires engagement and a valid had-issue value", async () => {
    const { data: session } = await teacherA.client
      .from("attendance_sessions")
      .select("id")
      .is("clock_out_at", null)
      .single();
    const { error } = await admin.rpc("close_session_from_zoho", {
      p_session_id: session!.id,
      p_engagement: "   ",
      p_had_issue: "No",
    });
    expect(error?.message ?? "").toMatch(/engagement is required/i);

    const { error: badIssueError } = await admin.rpc("close_session_from_zoho", {
      p_session_id: session!.id,
      p_engagement: "Very engaged",
      p_had_issue: "maybe",
    });
    expect(badIssueError?.message ?? "").toMatch(/yes or no/i);
  });

  it("closes the session via close_session_from_zoho, then allows the next clock-in", async () => {
    const { data: session } = await teacherA.client
      .from("attendance_sessions")
      .select("id")
      .is("clock_out_at", null)
      .single();
    const { data: closed, error: outError } = await admin.rpc("close_session_from_zoho", {
      p_session_id: session!.id,
      p_engagement: "Very engaged",
      p_had_issue: "Yes",
      p_issue_status: "In Progress: Efforts are currently underway to address and resolve the issue.",
      p_notes: "Need a new snare head.",
    });
    expect(outError).toBeNull();
    expect(closed?.clock_out_at).not.toBeNull();
    expect(closed?.feedback_engagement).toBe("Very engaged");
    expect(closed?.feedback_had_issue).toBe("Yes");

    // A retried webhook delivery for the same (now-closed) session is a
    // harmless no-op, not an error.
    const { data: retried, error: retryError } = await admin.rpc("close_session_from_zoho", {
      p_session_id: session!.id,
      p_engagement: "Not engaged",
      p_had_issue: "No",
    });
    expect(retryError).toBeNull();
    expect(retried?.feedback_engagement).toBe("Very engaged");

    // With no open session, clock-in is possible again.
    const { error: reError } = await teacherA.client.rpc("clock_in", {
      p_event_id: futureEventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
    });
    expect(reError).toBeNull();
  });
});
