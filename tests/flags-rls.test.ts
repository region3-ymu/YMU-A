// Hosted integration tests for Phase 9's stuck-feedback-session reliability
// path: detect_stuck_feedback_sessions() (service-role only, idempotent per
// session) and admin_close_stuck_session()'s side effect of resolving the
// flag it created. Same disposable-user pattern as the other RLS suites.

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

const SCHOOL_LAT = 25.7617;
const SCHOOL_LNG = -80.1918;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("stuck-feedback-session reliability (Phase 9)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `flags-rls-${randomUUID()}@example.com`;
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

  async function setRole(id: string, role: string) {
    const { error } = await admin.from("profiles").update({ role }).eq("id", id);
    if (error) throw new Error(`setRole failed: ${error.message}`);
  }

  async function createSchool(name: string) {
    const { data, error } = await admin
      .from("schools")
      .insert({ name, address: `${name} address`, lat: SCHOOL_LAT, lng: SCHOOL_LNG, geofence_radius_m: 200 })
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
        calendar_id: "flags-rls-test-calendar",
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

  let teacher: TestUser;
  let om: TestUser;
  let schoolId: string;
  let eventId: string;
  let sessionId: string;
  /** Older than any real unsettled session can plausibly be. */
  const STUCK_HOURS = 2_000;
  let preexistingFlagIds = new Set<string>();

  beforeAll(async () => {
    [teacher, om] = await Promise.all([createUser("Stuck Teacher"), createUser("Operations Manager")]);
    await setRole(om.id, "operations_manager");
    schoolId = await createSchool("Flags Test School");
    // Well in the past, so the session reads as long-open once clocked in.
    const past = new Date(Date.now() - 8 * 3_600_000).toISOString();
    eventId = await createEvent("flags-stuck", [teacher.id], schoolId, past);

    const { data: session, error } = await teacher.client.rpc("clock_in", {
      p_event_id: eventId,
      p_lat: SCHOOL_LAT,
      p_lng: SCHOOL_LNG,
      p_client_key: randomUUID(),
    });
    if (error || !session) throw new Error(`clock_in failed: ${error?.message}`);
    sessionId = session.id;
    // feedback_due_at is what the detector keys on, and backdating clock_in_at
    // alone (which is all this used to do) moves nothing: since 0026 a session
    // is "stuck" when its 24h feedback deadline has lapsed, not when it has
    // been open a while. clock_in() sets the deadline to end_at + 24h, so an
    // event an hour in the past is still due 23 hours from now.
    //
    // STUCK_HOURS is absurdly large on purpose. detect_stuck_feedback_sessions
    // takes no scope: it flags every eligible session in the organisation and
    // queues a push to that school's managers. A run on 21 August genuinely
    // sent one to a real Regional Manager. A threshold no real session can
    // reach keeps the blast radius to this suite's own row, and the afterAll
    // below sweeps anything that slips through anyway.
    await admin
      .from("attendance_sessions")
      .update({
        clock_in_at: past,
        feedback_due_at: new Date(Date.now() - (STUCK_HOURS + 24) * 3_600_000).toISOString(),
      })
      .eq("id", sessionId);

    const { data: preexisting } = await admin
      .from("flags")
      .select("id")
      .eq("type", "feedback_stuck");
    preexistingFlagIds = new Set((preexisting ?? []).map((f) => f.id as string));
  }, 60_000);

  afterAll(async () => {
    // Collateral first: any feedback_stuck flag that appeared during this run
    // on somebody else's session, plus the manager notifications it queued.
    // Deleting a queued push before notify-dispatch claims it is the only
    // window there is, which is the other reason STUCK_HOURS is so large.
    const { data: nowFlagged } = await admin.from("flags").select("id").eq("type", "feedback_stuck");
    const collateral = (nowFlagged ?? [])
      .map((f) => f.id as string)
      .filter((id) => !preexistingFlagIds.has(id));
    if (collateral.length) {
      await admin.from("notification_queue").delete().in("payload->>flag_id", collateral);
      await admin.from("flags").delete().in("id", collateral);
    }
    if (createdUserIds.length) {
      await admin.from("flags").delete().in("teacher_id", createdUserIds);
      await admin.from("attendance_sessions").delete().in("teacher_id", createdUserIds);
    }
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("detect_stuck_feedback_sessions is service-role only", async () => {
    const { error } = await teacher.client.rpc("detect_stuck_feedback_sessions", { p_stuck_after_hours: STUCK_HOURS });
    expect(error).not.toBeNull();
  });

  it("flags a session open past the threshold, and doesn't double-flag on a re-run", async () => {
    const { data: flaggedCount, error } = await admin.rpc("detect_stuck_feedback_sessions", {
      p_stuck_after_hours: STUCK_HOURS,
    });
    expect(error).toBeNull();
    expect(flaggedCount).toBeGreaterThan(0);

    const { data: flags } = await admin
      .from("flags")
      .select("id, type, session_id")
      .eq("type", "feedback_stuck")
      .eq("session_id", sessionId);
    expect(flags).toHaveLength(1);

    await admin.rpc("detect_stuck_feedback_sessions", { p_stuck_after_hours: STUCK_HOURS });
    const { data: flagsAfter } = await admin
      .from("flags")
      .select("id")
      .eq("type", "feedback_stuck")
      .eq("session_id", sessionId);
    expect(flagsAfter).toHaveLength(1);
  });

  it("admin_close_stuck_session resolves the feedback_stuck flag as a side effect", async () => {
    const { error } = await om.client.rpc("admin_close_stuck_session", {
      p_session_id: sessionId,
      p_reason: "Confirmed by phone.",
    });
    expect(error).toBeNull();

    const { data: flag } = await admin
      .from("flags")
      .select("resolved_at, resolved_by, details")
      .eq("type", "feedback_stuck")
      .eq("session_id", sessionId)
      .single();
    expect(flag?.resolved_at).not.toBeNull();
    expect(flag?.resolved_by).toBe(om.id);
    expect(String((flag?.details as Record<string, unknown>)?.resolution_notes ?? "")).toMatch(/force-closed/i);
  });
});
