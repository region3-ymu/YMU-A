// Hosted integration test for the review's L3 fix: close_session_from_zoho()
// verifies the submitted teacher owns the session before closing it, so a
// teacher can't close another teacher's session by editing the prefilled
// session_id in the Zoho form URL. The check is backward-compatible — omitting
// the teacher id preserves the pre-fix behavior. Same disposable-user pattern
// as the other RLS suites; every created row is cleaned up afterwards.

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

describe.runIf(configured)("close_session_from_zoho ownership (review L3)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `zoho-own-rls-${randomUUID()}@example.com`;
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

  async function createSchool(): Promise<string> {
    const { data, error } = await admin
      .from("schools")
      .insert({ name: `Zoho Own School ${randomUUID()}`, address: "addr", region: "central", lat: 25.7, lng: -80.1, geofence_radius_m: 200 })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createSchool failed: ${error?.message}`);
    createdSchoolIds.push(data.id);
    return data.id;
  }

  async function createEvent(teacherId: string, schoolId: string): Promise<string> {
    const { data, error } = await admin
      .from("calendar_events")
      .insert({
        calendar_id: "zoho-own-rls-calendar",
        google_event_id: `zoho-own-${randomUUID()}`,
        summary: "Zoho Own Class",
        start_at: new Date(Date.now() - 3_600_000).toISOString(),
        end_at: new Date(Date.now() - 1_800_000).toISOString(),
        teacher_ids: [teacherId],
        school_id: schoolId,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createEvent failed: ${error?.message}`);
    createdEventIds.push(data.id);
    return data.id;
  }

  async function openSession(teacherId: string, eventId: string, schoolId: string): Promise<string> {
    const { data, error } = await admin
      .from("attendance_sessions")
      .insert({ teacher_id: teacherId, event_id: eventId, school_id: schoolId, clock_in_status: "on_time" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`openSession failed: ${error?.message}`);
    return data.id;
  }

  let teacherA: TestUser;
  let teacherB: TestUser;
  let schoolId: string;
  let eventId: string;

  beforeAll(async () => {
    [teacherA, teacherB] = await Promise.all([createUser("Teacher A"), createUser("Teacher B")]);
    schoolId = await createSchool();
    eventId = await createEvent(teacherA.id, schoolId);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length) await admin.from("attendance_sessions").delete().in("teacher_id", createdUserIds);
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("refuses to close a session when the submitted teacher id is a different teacher", async () => {
    const sessionId = await openSession(teacherA.id, eventId, schoolId);
    const { error } = await admin.rpc("close_session_from_zoho", {
      p_session_id: sessionId,
      p_engagement: "Very engaged",
      p_had_issue: "No",
      p_teacher_id: teacherB.id,
    });
    expect(error).not.toBeNull();

    const { data } = await admin.from("attendance_sessions").select("clock_out_at").eq("id", sessionId).single();
    expect(data?.clock_out_at).toBeNull();

    // Free the one-open-session-per-teacher slot for the next case (the reject
    // path deliberately left this session open).
    await admin.from("attendance_sessions").delete().eq("id", sessionId);
  });

  it("closes the session when the submitted teacher id matches the owner, stamping zoho_synced_at", async () => {
    const sessionId = await openSession(teacherA.id, eventId, schoolId);
    const { error } = await admin.rpc("close_session_from_zoho", {
      p_session_id: sessionId,
      p_engagement: "Very engaged",
      p_had_issue: "No",
      p_teacher_id: teacherA.id,
    });
    expect(error).toBeNull();

    const { data } = await admin
      .from("attendance_sessions")
      .select("clock_out_at, zoho_synced_at")
      .eq("id", sessionId)
      .single();
    expect(data?.clock_out_at).not.toBeNull();
    expect(data?.zoho_synced_at).not.toBeNull();
  });

  it("still closes when no teacher id is supplied (backward-compatible)", async () => {
    const sessionId = await openSession(teacherA.id, eventId, schoolId);
    const { error } = await admin.rpc("close_session_from_zoho", {
      p_session_id: sessionId,
      p_engagement: "Somewhat engaged",
      p_had_issue: "No",
    });
    expect(error).toBeNull();

    const { data } = await admin.from("attendance_sessions").select("clock_out_at").eq("id", sessionId).single();
    expect(data?.clock_out_at).not.toBeNull();
  });
});
