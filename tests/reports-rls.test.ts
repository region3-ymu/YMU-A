// Hosted integration tests for Phase 8 reporting: attendance_period_rows'
// authorization (a teacher never sees a co-scheduled colleague's row, a
// Regional Manager never sees the other region's rows) and
// report_teacher_roster's region scoping + archived-teacher inclusion.
// Same disposable-user pattern as the other RLS suites; every created row
// is cleaned up afterwards. Sessions are seeded directly via the
// service-role client (not through clock_in()) so hours/status are exact,
// known values to reconcile against — clock_in()'s own geofence/status
// logic is already covered by tests/attendance-rls.test.ts.

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

type TestUser = { id: string; email: string; full_name: string; client: SupabaseClient };

describe.runIf(configured)("Attendance reporting (Phase 8)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdSessionIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `reports-rls-${randomUUID()}@example.com`;
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
    return { id: data.user.id, email, full_name: fullName, client };
  }

  async function setRole(id: string, role: string, region: string | null = null) {
    const { error } = await admin.from("profiles").update({ role, region }).eq("id", id);
    if (error) throw new Error(`setRole failed: ${error.message}`);
  }

  async function archiveUser(id: string) {
    const { error } = await admin.from("profiles").update({ archived_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(`archiveUser failed: ${error.message}`);
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

  async function createEvent(name: string, teacherIds: string[], schoolId: string, startAt: string, endAt: string) {
    const { data, error } = await admin
      .from("calendar_events")
      .insert({
        calendar_id: "reports-rls-test-calendar",
        google_event_id: name,
        summary: name,
        start_at: startAt,
        end_at: endAt,
        teacher_ids: teacherIds,
        school_id: schoolId,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createEvent failed: ${error?.message}`);
    createdEventIds.push(data.id);
    return data.id;
  }

  async function createSession(opts: {
    teacherId: string;
    eventId: string;
    schoolId: string;
    clockInAt: string;
    clockOutAt: string | null;
    status: "on_time" | "late";
  }) {
    const { data, error } = await admin
      .from("attendance_sessions")
      .insert({
        teacher_id: opts.teacherId,
        event_id: opts.eventId,
        school_id: opts.schoolId,
        clock_in_at: opts.clockInAt,
        clock_in_lat: SCHOOL_LAT,
        clock_in_lng: SCHOOL_LNG,
        clock_in_accuracy_m: 10,
        clock_in_distance_m: 0,
        clock_in_status: opts.status,
        clock_out_at: opts.clockOutAt,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createSession failed: ${error?.message}`);
    createdSessionIds.push(data.id);
    return data.id;
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  let teacherActive: TestUser;
  let teacherSub: TestUser;
  let teacherArchived: TestUser;
  let teacherEast: TestUser;
  let rmCentral: TestUser;
  let rmEast: TestUser;
  let om: TestUser;
  let centralSchoolId: string;
  let eastSchoolId: string;

  let onTimeEventId: string;
  let lateEventId: string;
  let missedEventId: string;
  let upcomingEventId: string;
  let sharedEventId: string; // co-taught by teacherActive + teacherSub
  let eastEventId: string;
  let archivedEventId: string;

  beforeAll(async () => {
    [teacherActive, teacherSub, teacherArchived, teacherEast, rmCentral, rmEast, om] = await Promise.all([
      createUser("Reports Teacher Active"),
      createUser("Reports Teacher Sub"),
      createUser("Reports Teacher Archived"),
      createUser("Reports Teacher East"),
      createUser("Reports RM Central"),
      createUser("Reports RM East"),
      createUser("Reports OM"),
    ]);
    await Promise.all([
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(rmEast.id, "regional_manager", "east"),
      setRole(om.id, "operations_manager"),
    ]);

    [centralSchoolId, eastSchoolId] = await Promise.all([
      createSchool("Reports Central School", "central"),
      createSchool("Reports East School", "east"),
    ]);

    [onTimeEventId, lateEventId, missedEventId, upcomingEventId, sharedEventId, eastEventId, archivedEventId] =
      await Promise.all([
        createEvent("reports-on-time", [teacherActive.id], centralSchoolId, hoursAgo(4), hoursAgo(3)),
        createEvent("reports-late", [teacherActive.id], centralSchoolId, hoursAgo(8), hoursAgo(6)),
        createEvent("reports-missed", [teacherActive.id], centralSchoolId, hoursAgo(2), hoursAgo(1)),
        createEvent("reports-upcoming", [teacherActive.id], centralSchoolId, hoursFromNow(2), hoursFromNow(3)),
        createEvent("reports-shared", [teacherActive.id, teacherSub.id], centralSchoolId, hoursAgo(10), hoursAgo(9)),
        createEvent("reports-east", [teacherEast.id], eastSchoolId, hoursAgo(4), hoursAgo(3)),
        createEvent("reports-archived", [teacherArchived.id], centralSchoolId, hoursAgo(20), hoursAgo(19)),
      ]);

    await Promise.all([
      // Exactly 1 hour worked, on_time.
      createSession({
        teacherId: teacherActive.id,
        eventId: onTimeEventId,
        schoolId: centralSchoolId,
        clockInAt: hoursAgo(4),
        clockOutAt: hoursAgo(3),
        status: "on_time",
      }),
      // Exactly 2 hours worked, late.
      createSession({
        teacherId: teacherActive.id,
        eventId: lateEventId,
        schoolId: centralSchoolId,
        clockInAt: hoursAgo(8),
        clockOutAt: hoursAgo(6),
        status: "late",
      }),
      // reports-missed intentionally has NO session row.
      // reports-upcoming intentionally has NO session row (hasn't happened yet).
      createSession({
        teacherId: teacherActive.id,
        eventId: sharedEventId,
        schoolId: centralSchoolId,
        clockInAt: hoursAgo(10),
        clockOutAt: hoursAgo(9),
        status: "on_time",
      }),
      createSession({
        teacherId: teacherSub.id,
        eventId: sharedEventId,
        schoolId: centralSchoolId,
        clockInAt: hoursAgo(10),
        clockOutAt: hoursAgo(9.5),
        status: "late",
      }),
      createSession({
        teacherId: teacherEast.id,
        eventId: eastEventId,
        schoolId: eastSchoolId,
        clockInAt: hoursAgo(4),
        clockOutAt: hoursAgo(3),
        status: "on_time",
      }),
      createSession({
        teacherId: teacherArchived.id,
        eventId: archivedEventId,
        schoolId: centralSchoolId,
        clockInAt: hoursAgo(20),
        clockOutAt: hoursAgo(19),
        status: "on_time",
      }),
    ]);

    await archiveUser(teacherArchived.id);
  }, 60_000);

  afterAll(async () => {
    if (createdSessionIds.length) await admin.from("attendance_sessions").delete().in("id", createdSessionIds);
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("a teacher's own attendance_period_rows reconcile exactly against the seeded raw rows", async () => {
    const { data, error } = await teacherActive.client
      .from("attendance_period_rows")
      .select("event_id, attendance_status, hours_worked")
      .in("event_id", [onTimeEventId, lateEventId, missedEventId, upcomingEventId]);
    expect(error).toBeNull();
    const byEvent = new Map((data ?? []).map((r) => [r.event_id, r]));

    expect(byEvent.get(onTimeEventId)?.attendance_status).toBe("on_time");
    expect(byEvent.get(onTimeEventId)?.hours_worked).toBeCloseTo(1, 3);

    expect(byEvent.get(lateEventId)?.attendance_status).toBe("late");
    expect(byEvent.get(lateEventId)?.hours_worked).toBeCloseTo(2, 3);

    expect(byEvent.get(missedEventId)?.attendance_status).toBe("missed");
    expect(byEvent.get(missedEventId)?.hours_worked).toBeNull();

    expect(byEvent.get(upcomingEventId)?.attendance_status).toBe("upcoming");
  });

  it("a co-scheduled teacher never sees their colleague's row on a shared event (array-unnest leak check)", async () => {
    const { data: activeView } = await teacherActive.client
      .from("attendance_period_rows")
      .select("teacher_id, attendance_status")
      .eq("event_id", sharedEventId);
    expect(activeView).toHaveLength(1);
    expect(activeView![0].teacher_id).toBe(teacherActive.id);
    expect(activeView![0].attendance_status).toBe("on_time");

    const { data: subView } = await teacherSub.client
      .from("attendance_period_rows")
      .select("teacher_id, attendance_status")
      .eq("event_id", sharedEventId);
    expect(subView).toHaveLength(1);
    expect(subView![0].teacher_id).toBe(teacherSub.id);
    expect(subView![0].attendance_status).toBe("late");
  });

  it("a Regional Manager only sees their own region's rows, never the other region's", async () => {
    const { data: centralRows } = await rmCentral.client
      .from("attendance_period_rows")
      .select("event_id")
      .in("event_id", [onTimeEventId, eastEventId]);
    const centralEventIds = (centralRows ?? []).map((r) => r.event_id);
    expect(centralEventIds).toContain(onTimeEventId);
    expect(centralEventIds).not.toContain(eastEventId);

    const { data: eastRows } = await rmEast.client
      .from("attendance_period_rows")
      .select("event_id")
      .in("event_id", [onTimeEventId, eastEventId]);
    const eastEventIds = (eastRows ?? []).map((r) => r.event_id);
    expect(eastEventIds).toContain(eastEventId);
    expect(eastEventIds).not.toContain(onTimeEventId);
  });

  it("OM sees rows from both regions", async () => {
    const { data } = await om.client
      .from("attendance_period_rows")
      .select("event_id")
      .in("event_id", [onTimeEventId, eastEventId]);
    const ids = (data ?? []).map((r) => r.event_id);
    expect(ids).toContain(onTimeEventId);
    expect(ids).toContain(eastEventId);
  });

  it("report_teacher_roster scopes a Regional Manager by school region, not profiles.region", async () => {
    const { data: centralRoster } = await rmCentral.client.rpc("report_teacher_roster", {
      p_include_archived: false,
    });
    const centralIds = (centralRoster ?? []).map((t: { id: string }) => t.id);
    expect(centralIds).toContain(teacherActive.id);
    expect(centralIds).not.toContain(teacherEast.id);

    const { data: eastRoster } = await rmEast.client.rpc("report_teacher_roster", { p_include_archived: false });
    const eastIds = (eastRoster ?? []).map((t: { id: string }) => t.id);
    expect(eastIds).toContain(teacherEast.id);
    expect(eastIds).not.toContain(teacherActive.id);
  });

  it("report_teacher_roster only includes an archived teacher when p_include_archived is true", async () => {
    const { data: withoutArchived } = await om.client.rpc("report_teacher_roster", { p_include_archived: false });
    expect((withoutArchived ?? []).map((t: { id: string }) => t.id)).not.toContain(teacherArchived.id);

    const { data: withArchived } = await om.client.rpc("report_teacher_roster", { p_include_archived: true });
    const withArchivedIds = (withArchived ?? []).map((t: { id: string }) => t.id);
    expect(withArchivedIds).toContain(teacherArchived.id);
    expect(withArchivedIds).toContain(teacherActive.id);
  });

  it("an archived teacher's historical attendance rows are still visible to OM via attendance_period_rows", async () => {
    const { data } = await om.client
      .from("attendance_period_rows")
      .select("event_id, attendance_status, hours_worked")
      .eq("event_id", archivedEventId);
    expect(data).toHaveLength(1);
    expect(data![0].attendance_status).toBe("on_time");
    expect(data![0].hours_worked).toBeCloseTo(1, 3);
  });
});
