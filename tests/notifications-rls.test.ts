// Hosted integration tests for Phase 7 notifications: push_subscriptions and
// notification_preferences RLS (both strictly self-scoped, no manager
// visibility), and enqueue_reminder_notifications() — the reminder-due
// computation notify-dispatch calls every run. Same disposable-user pattern
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

const SCHOOL_LAT = 25.7617;
const SCHOOL_LNG = -80.1918;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("Notifications (Phase 7)", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `notify-rls-${randomUUID()}@example.com`;
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

  async function createSchool(name: string) {
    const { data, error } = await admin
      .from("schools")
      .insert({ name, address: `${name} address`, region: "central", lat: SCHOOL_LAT, lng: SCHOOL_LNG, geofence_radius_m: 200 })
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
        calendar_id: "notify-rls-test-calendar",
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

  let userA: TestUser;
  let userB: TestUser;
  let schoolId: string;

  beforeAll(async () => {
    [userA, userB] = await Promise.all([createUser("Notify User A"), createUser("Notify User B")]);
    schoolId = await createSchool("Notify RLS School");
  }, 60_000);

  afterAll(async () => {
    if (createdEventIds.length) await admin.from("calendar_events").delete().in("id", createdEventIds);
    if (createdUserIds.length) {
      await admin.from("notification_queue").delete().in("recipient_id", createdUserIds);
      await admin.from("attendance_sessions").delete().in("teacher_id", createdUserIds);
    }
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  describe("push_subscriptions RLS", () => {
    let endpointA: string;

    it("a user can insert and read their own subscription", async () => {
      endpointA = `https://push.example.com/${randomUUID()}`;
      const { error } = await userA.client
        .from("push_subscriptions")
        .insert({ user_id: userA.id, endpoint: endpointA, p256dh: "p256dh-key", auth: "auth-key" });
      expect(error).toBeNull();

      const { data } = await userA.client.from("push_subscriptions").select("id, endpoint").eq("endpoint", endpointA);
      expect(data ?? []).toHaveLength(1);
    });

    it("another user cannot see or delete it", async () => {
      const { data: bView } = await userB.client.from("push_subscriptions").select("id").eq("endpoint", endpointA);
      expect(bView ?? []).toHaveLength(0);

      await userB.client.from("push_subscriptions").delete().eq("endpoint", endpointA);
      const { data: stillThere } = await admin.from("push_subscriptions").select("id").eq("endpoint", endpointA);
      expect(stillThere ?? []).toHaveLength(1);
    });

    it("a user cannot insert a subscription for someone else's user_id", async () => {
      const { error } = await userB.client
        .from("push_subscriptions")
        .insert({ user_id: userA.id, endpoint: `https://push.example.com/${randomUUID()}`, p256dh: "x", auth: "y" });
      expect(error).not.toBeNull();
    });

    // Regression: 0014 granted authenticated only select/insert/delete on
    // this table, missing update — saveSubscription()'s upsert() resolves to
    // an UPDATE for an already-known endpoint (re-enabling on the same
    // device/browser), which failed with "permission denied for table
    // push_subscriptions" until 0015 added the grant.
    it("re-subscribing on the same endpoint (upsert -> UPDATE path) succeeds", async () => {
      const endpoint = `https://push.example.com/${randomUUID()}`;
      const { error: firstError } = await userA.client
        .from("push_subscriptions")
        .upsert({ user_id: userA.id, endpoint, p256dh: "key-1", auth: "auth-1" }, { onConflict: "endpoint" });
      expect(firstError).toBeNull();

      const { error: secondError } = await userA.client
        .from("push_subscriptions")
        .upsert({ user_id: userA.id, endpoint, p256dh: "key-2", auth: "auth-2" }, { onConflict: "endpoint" });
      expect(secondError).toBeNull();

      const { data } = await userA.client.from("push_subscriptions").select("p256dh").eq("endpoint", endpoint).single();
      expect(data?.p256dh).toBe("key-2");
    });
  });

  describe("notification_preferences RLS", () => {
    it("a user can upsert and read their own preference row", async () => {
      const { error } = await userA.client
        .from("notification_preferences")
        .upsert({ user_id: userA.id, type: "be_there_soon", enabled: false, lead_minutes: 20 });
      expect(error).toBeNull();

      const { data } = await userA.client
        .from("notification_preferences")
        .select("enabled, lead_minutes")
        .eq("user_id", userA.id)
        .eq("type", "be_there_soon")
        .single();
      expect(data?.enabled).toBe(false);
      expect(data?.lead_minutes).toBe(20);
    });

    it("another user cannot see or modify it", async () => {
      const { data } = await userB.client
        .from("notification_preferences")
        .select("id")
        .eq("user_id", userA.id);
      expect(data ?? []).toHaveLength(0);

      const { error } = await userB.client
        .from("notification_preferences")
        .update({ enabled: true })
        .eq("user_id", userA.id)
        .eq("type", "be_there_soon");
      // RLS silently matches zero rows rather than erroring.
      expect(error).toBeNull();
      const { data: unchanged } = await admin
        .from("notification_preferences")
        .select("enabled")
        .eq("user_id", userA.id)
        .eq("type", "be_there_soon")
        .single();
      expect(unchanged?.enabled).toBe(false);
    });

    it("an invalid type is rejected by the check constraint", async () => {
      const { error } = await userA.client
        .from("notification_preferences")
        .upsert({ user_id: userA.id, type: "not_a_real_type", enabled: true });
      expect(error).not.toBeNull();
    });
  });

  describe("enqueue_reminder_notifications()", () => {
    it("is not callable by an authenticated client, only service_role", async () => {
      const { error } = await userA.client.rpc("enqueue_reminder_notifications");
      expect(error).not.toBeNull();
    });

    it("fires be_there_soon for a class starting within the default 15-minute lead, not for one further out", async () => {
      const soon = new Date(Date.now() + 10 * 60_000).toISOString();
      const far = new Date(Date.now() + 45 * 60_000).toISOString();
      const soonEventId = await createEvent(
        "reminder-soon",
        [userA.id],
        schoolId,
        soon,
        new Date(new Date(soon).getTime() + 3_600_000).toISOString(),
      );
      const farEventId = await createEvent(
        "reminder-far",
        [userA.id],
        schoolId,
        far,
        new Date(new Date(far).getTime() + 3_600_000).toISOString(),
      );

      const { error } = await admin.rpc("enqueue_reminder_notifications");
      expect(error).toBeNull();

      const { data: soonRows } = await admin
        .from("notification_queue")
        .select("id")
        .eq("event_id", soonEventId)
        .eq("type", "be_there_soon");
      expect(soonRows ?? []).toHaveLength(1);

      const { data: farRows } = await admin
        .from("notification_queue")
        .select("id")
        .eq("event_id", farEventId)
        .eq("type", "be_there_soon");
      expect(farRows ?? []).toHaveLength(0);
    });

    it("respects a per-user lead_minutes override, and re-running never duplicates a fired reminder", async () => {
      // userB has a 5-minute lead on file; a class 10 minutes out is within
      // userA's default 15-minute lead but NOT within userB's 5-minute one.
      await admin
        .from("notification_preferences")
        .upsert({ user_id: userB.id, type: "be_there_soon", enabled: true, lead_minutes: 5 });

      const tenOut = new Date(Date.now() + 10 * 60_000).toISOString();
      const sharedEventId = await createEvent(
        "reminder-shared",
        [userA.id, userB.id],
        schoolId,
        tenOut,
        new Date(new Date(tenOut).getTime() + 3_600_000).toISOString(),
      );

      await admin.rpc("enqueue_reminder_notifications");
      await admin.rpc("enqueue_reminder_notifications"); // second run: must not duplicate

      const { data: aRows } = await admin
        .from("notification_queue")
        .select("id")
        .eq("event_id", sharedEventId)
        .eq("type", "be_there_soon")
        .eq("recipient_id", userA.id);
      expect(aRows ?? []).toHaveLength(1);

      const { data: bRows } = await admin
        .from("notification_queue")
        .select("id")
        .eq("event_id", sharedEventId)
        .eq("type", "be_there_soon")
        .eq("recipient_id", userB.id);
      expect(bRows ?? []).toHaveLength(0);
    });

    it("fires clock_in_reminder once a class has started with no attendance_sessions row, and stops once one exists", async () => {
      const justStarted = new Date(Date.now() - 1 * 60_000).toISOString();
      const eventId = await createEvent(
        "reminder-clockin",
        [userA.id],
        schoolId,
        justStarted,
        new Date(new Date(justStarted).getTime() + 3_600_000).toISOString(),
      );

      await admin.rpc("enqueue_reminder_notifications");
      const { data: rows } = await admin
        .from("notification_queue")
        .select("id")
        .eq("event_id", eventId)
        .eq("type", "clock_in_reminder")
        .eq("recipient_id", userA.id);
      expect(rows ?? []).toHaveLength(1);

      // Clock in, then re-run — must not insert a second reminder, and the
      // "not exists attendance_sessions" guard should skip it going forward.
      await admin.from("attendance_sessions").insert({
        teacher_id: userA.id,
        event_id: eventId,
        school_id: schoolId,
        clock_in_status: "on_time",
      });
      await admin.rpc("enqueue_reminder_notifications");
      const { data: rowsAfter } = await admin
        .from("notification_queue")
        .select("id")
        .eq("event_id", eventId)
        .eq("type", "clock_in_reminder")
        .eq("recipient_id", userA.id);
      expect(rowsAfter ?? []).toHaveLength(1);
    });

    it("fires clock_out_reminder for a still-open session past class end, with email_status pending", async () => {
      const ended = new Date(Date.now() - 5 * 60_000).toISOString();
      const eventId = await createEvent(
        "reminder-clockout",
        [userB.id],
        schoolId,
        new Date(new Date(ended).getTime() - 3_600_000).toISOString(),
        ended,
      );
      await admin.from("attendance_sessions").insert({
        teacher_id: userB.id,
        event_id: eventId,
        school_id: schoolId,
        clock_in_status: "on_time",
      });

      await admin.rpc("enqueue_reminder_notifications");
      const { data: rows } = await admin
        .from("notification_queue")
        .select("id, email_status")
        .eq("event_id", eventId)
        .eq("type", "clock_out_reminder")
        .eq("recipient_id", userB.id);
      expect(rows ?? []).toHaveLength(1);
      expect(rows![0].email_status).toBe("pending");
    });
  });
});
