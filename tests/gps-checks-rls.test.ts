// Hosted integration tests for Phase 5 GPS checks & late escalation:
// clock_in()'s 5 seeded gps_checks rows, record_gps_check (in-fence vs.
// out-of-fence, flag + notification_queue on the latter), gps_checks/flags
// RLS (flags are manager-only, not teacher-visible), close_out_overdue_gps_checks,
// detect_late_clockins, and resolve_flag's region gating. Same disposable-user
// pattern as the other RLS suites; every created row is cleaned up afterwards.

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

// Same real-ish Miami location as tests/attendance-rls.test.ts; "far" is
// ~2 km north, well outside a 200 m fence.
const SCHOOL_LAT = 25.7617;
const SCHOOL_LNG = -80.1918;
const FAR_LAT = 25.782;
const FAR_LNG = -80.1918;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("GPS checks & late escalation (Phase 5)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `gps-rls-${randomUUID()}@example.com`;
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
        calendar_id: "gps-rls-test-calendar",
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

  let teacherA: TestUser;
  let teacherLate: TestUser;
  let rmCentral: TestUser;
  let rmEast: TestUser;
  let om: TestUser;
  let centralSchoolId: string;
  let futureEventId: string;
  let lateEventId: string; // started 10 min ago, never clocked into

  beforeAll(async () => {
    [teacherA, teacherLate, rmCentral, rmEast, om] = await Promise.all([
      createUser("Teacher A"),
      createUser("Teacher Late"),
      createUser("RM Central"),
      createUser("RM East"),
      createUser("Operations Manager"),
    ]);
    await Promise.all([
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(rmEast.id, "regional_manager", "east"),
      setRole(om.id, "operations_manager"),
    ]);
    [centralSchoolId] = await Promise.all([
      createSchool("GPS Central School", "central"),
      createSchool("GPS East School", "east"),
    ]);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    [futureEventId, lateEventId] = await Promise.all([
      createEvent("gps-future", [teacherA.id], centralSchoolId, future),
      createEvent("gps-late", [teacherLate.id], centralSchoolId, tenMinAgo),
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

  let sessionId: string;

  it("clock_in seeds 5 pending gps_checks due at +5/10/15/20/25 min", async () => {
    const { data: session, error } = await teacherA.client.rpc("clock_in", {
      p_event_id: futureEventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 10,
    });
    expect(error).toBeNull();
    sessionId = session!.id;

    const { data: checks } = await teacherA.client
      .from("gps_checks")
      .select("id, due_at, status")
      .eq("session_id", sessionId)
      .order("due_at", { ascending: true });
    expect(checks).toHaveLength(5);
    expect(checks!.every((c) => c.status === "pending")).toBe(true);

    const clockInAt = new Date(session!.clock_in_at).getTime();
    const expectedOffsetsMin = [5, 10, 15, 20, 25];
    checks!.forEach((c, i) => {
      const deltaMin = Math.round((new Date(c.due_at).getTime() - clockInAt) / 60_000);
      expect(deltaMin).toBe(expectedOffsetsMin[i]);
    });
  });

  it("recording an in-fence check marks it verified with no flag", async () => {
    const { data: checks } = await teacherA.client
      .from("gps_checks")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .order("due_at", { ascending: true })
      .limit(1);
    const checkId = checks![0].id;

    const { data: updated, error } = await teacherA.client.rpc("record_gps_check", {
      p_check_id: checkId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_accuracy_m: 15,
    });
    expect(error).toBeNull();
    expect(updated?.status).toBe("verified");

    const { data: flags } = await admin.from("flags").select("id").eq("gps_check_id", checkId);
    expect(flags ?? []).toHaveLength(0);
  });

  it("recording an out-of-fence check raises a flag and queues an RM notification, invisible to the teacher", async () => {
    const { data: checks } = await teacherA.client
      .from("gps_checks")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .order("due_at", { ascending: true })
      .limit(1);
    const checkId = checks![0].id;

    const { data: updated, error } = await teacherA.client.rpc("record_gps_check", {
      p_check_id: checkId,
      p_lat: FAR_LAT,
      p_lng: FAR_LNG,
      p_accuracy_m: 15,
    });
    expect(error).toBeNull();
    expect(updated?.status).toBe("out_of_fence");

    const { data: flags } = await admin.from("flags").select("id, type, teacher_id").eq("gps_check_id", checkId);
    expect(flags ?? []).toHaveLength(1);
    expect(flags![0].type).toBe("gps_out_of_fence");

    const { data: notifications } = await admin
      .from("notification_queue")
      .select("recipient_id, type")
      .eq("type", "gps_out_of_fence")
      .eq("recipient_id", rmCentral.id);
    expect((notifications ?? []).length).toBeGreaterThan(0);

    // Flags are a manager tool, not part of the teacher's own record.
    const { data: teacherView } = await teacherA.client.from("flags").select("id").eq("gps_check_id", checkId);
    expect(teacherView ?? []).toHaveLength(0);
  });

  it("the in-region RM sees the flag; the other region's RM does not; OM sees it too", async () => {
    const { data: central } = await rmCentral.client.from("flags").select("id").eq("teacher_id", teacherA.id);
    const { data: east } = await rmEast.client.from("flags").select("id").eq("teacher_id", teacherA.id);
    const { data: omRows } = await om.client.from("flags").select("id").eq("teacher_id", teacherA.id);
    expect((central ?? []).length).toBeGreaterThan(0);
    expect((east ?? []).length).toBe(0);
    expect((omRows ?? []).length).toBeGreaterThan(0);
  });

  it("resolve_flag rejects the out-of-region RM and succeeds for the in-region RM", async () => {
    const { data: flag } = await admin.from("flags").select("id").eq("teacher_id", teacherA.id).limit(1).single();

    const { error: wrongRegionError } = await rmEast.client.rpc("resolve_flag", { p_flag_id: flag!.id });
    expect(wrongRegionError?.message ?? "").toMatch(/own region/i);

    const { data: resolved, error } = await rmCentral.client.rpc("resolve_flag", { p_flag_id: flag!.id });
    expect(error).toBeNull();
    expect(resolved?.resolved_at).not.toBeNull();
    expect(resolved?.resolved_by).toBe(rmCentral.id);
  });

  it("close_out_overdue_gps_checks marks unrun-but-overdue checks as unverifiable, raising no flag", async () => {
    const { data: pending } = await admin
      .from("gps_checks")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "pending");
    expect((pending ?? []).length).toBeGreaterThan(0);

    // Backdate one so it reads as overdue without waiting 15+ minutes.
    const targetId = pending![0].id;
    await admin.from("gps_checks").update({ due_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", targetId);

    const { data: closedCount, error } = await admin.rpc("close_out_overdue_gps_checks");
    expect(error).toBeNull();
    expect(closedCount).toBeGreaterThan(0);

    const { data: after } = await admin.from("gps_checks").select("status").eq("id", targetId).single();
    expect(after?.status).toBe("unverifiable");

    const { data: flags } = await admin.from("flags").select("id").eq("gps_check_id", targetId);
    expect(flags ?? []).toHaveLength(0);
  });

  it("detect_late_clockins flags a missed clock-in and queues an RM notification, then doesn't double-flag on a re-run", async () => {
    const { data: flaggedCount, error } = await admin.rpc("detect_late_clockins");
    expect(error).toBeNull();
    expect(flaggedCount).toBeGreaterThan(0);

    const { data: flags } = await admin
      .from("flags")
      .select("id, type, teacher_id, event_id")
      .eq("type", "late_clock_in")
      .eq("event_id", lateEventId);
    expect(flags).toHaveLength(1);
    expect(flags![0].teacher_id).toBe(teacherLate.id);

    const { data: notifications } = await admin
      .from("notification_queue")
      .select("recipient_id")
      .eq("type", "late_clock_in")
      .eq("recipient_id", rmCentral.id);
    expect((notifications ?? []).length).toBeGreaterThan(0);

    // Re-running must not create a second flag for the same missed clock-in.
    await admin.rpc("detect_late_clockins");
    const { data: flagsAfter } = await admin
      .from("flags")
      .select("id")
      .eq("type", "late_clock_in")
      .eq("event_id", lateEventId);
    expect(flagsAfter).toHaveLength(1);
  });
});
