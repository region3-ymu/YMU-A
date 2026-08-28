// The four org-wide roles are one account with four names (migrations 0072-0073).
//
// Written as a LOOP over the four roles on purpose. The bug this replaces was
// not a missing policy, it was drift: academic_manager was global on tickets and
// feedback but absent from attendance, flags, schedules and reports, so
// "sees everything" quietly meant two different things depending on the table.
// Asserting one role at a time is how that survived. Asserting all four against
// the same fixture is what makes the next divergence fail here.

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

// cpo is excluded: 0003 seeds it by hand and promote_user() refuses to assign
// it, so a disposable one cannot be made. The other three exercise the same
// current_sees_all_regions() branch.
const GLOBAL_ROLES = ["operations_manager", "academic_manager", "administrator"] as const;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("the org-wide roles", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  const globals: Record<string, TestUser> = {};
  let southRm: TestUser;
  let teacher: TestUser;
  let southSchoolId: string;
  let eventId: string;
  let sessionId: string;
  let flagId: string;

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `global-rls-${randomUUID()}@example.com`;
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

  beforeAll(async () => {
    for (const role of GLOBAL_ROLES) {
      globals[role] = await createUser(`Global Suite ${role}`);
      await admin.from("profiles").update({ role }).eq("id", globals[role].id);
    }
    southRm = await createUser("Global Suite South RM");
    await admin.from("profiles").update({ role: "regional_manager", region: "south" }).eq("id", southRm.id);
    teacher = await createUser("Global Suite Teacher");

    // The fixture sits in SOUTH, so nothing here is any global role's "own"
    // region — they see it because they see everything, not by coincidence.
    const { data: school, error: schoolError } = await admin
      .from("schools")
      .insert({
        name: `Global Suite School ${randomUUID().slice(0, 8)}`,
        address: "1 Test Way, Homestead, FL",
        region: "south",
      })
      .select("id")
      .single();
    if (schoolError || !school) throw new Error(`school insert failed: ${schoolError?.message}`);
    southSchoolId = school.id;
    createdSchoolIds.push(southSchoolId);

    const { data: sy } = await admin
      .from("school_years")
      .select("start_date")
      .eq("archived", false)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const day = (sy?.start_date as string) ?? new Date().toISOString().slice(0, 10);

    const { data: event, error: eventError } = await admin
      .from("calendar_events")
      .insert({
        calendar_id: "global-suite@group.calendar.google.com",
        google_event_id: `global-suite-${randomUUID()}`,
        summary: "Drumline",
        school_id: southSchoolId,
        teacher_ids: [teacher.id],
        start_at: `${day}T13:00:00Z`,
        end_at: `${day}T14:00:00Z`,
        status: "confirmed",
      })
      .select("id")
      .single();
    if (eventError || !event) throw new Error(`event insert failed: ${eventError?.message}`);
    eventId = event.id;
    createdEventIds.push(eventId);

    const { data: session } = await admin
      .from("attendance_sessions")
      .insert({
        teacher_id: teacher.id,
        event_id: eventId,
        school_id: southSchoolId,
        clock_in_at: `${day}T13:00:00Z`,
        clock_in_status: "late",
        scheduled_start_at: `${day}T13:00:00Z`,
      })
      .select("id")
      .single();
    sessionId = session!.id;

    const { data: flag } = await admin
      .from("flags")
      .insert({
        type: "late_clock_in",
        session_id: sessionId,
        event_id: eventId,
        teacher_id: teacher.id,
        school_id: southSchoolId,
        details: {},
      })
      .select("id")
      .single();
    flagId = flag!.id;
  }, 120_000);

  afterAll(async () => {
    await admin.from("flags").delete().in("event_id", createdEventIds);
    await admin.from("attendance_sessions").delete().in("event_id", createdEventIds);
    await admin.from("calendar_events").delete().in("id", createdEventIds);
    await admin.from("schools").delete().in("id", createdSchoolIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  }, 60_000);

  for (const role of GLOBAL_ROLES) {
    describe(role, () => {
      // The four tables academic_manager was missing before 0072. These are the
      // regression tests for the drift, not decoration.
      it("reads a class in a region that is not theirs", async () => {
        const { data } = await globals[role].client
          .from("calendar_events")
          .select("id")
          .eq("id", eventId);
        expect(data).toHaveLength(1);
      });

      it("reads its attendance session", async () => {
        const { data } = await globals[role].client
          .from("attendance_sessions")
          .select("id")
          .eq("id", sessionId);
        expect(data).toHaveLength(1);
      });

      it("reads its flag", async () => {
        const { data } = await globals[role].client.from("flags").select("id").eq("id", flagId);
        expect(data).toHaveLength(1);
      });

      it("reads the school", async () => {
        const { data } = await globals[role].client
          .from("schools")
          .select("id")
          .eq("id", southSchoolId);
        expect(data).toHaveLength(1);
      });

      it("gets the teacher's name from report_teacher_roster", async () => {
        const { data, error } = await globals[role].client.rpc("report_teacher_roster", {
          p_include_archived: true,
        });
        expect(error).toBeNull();
        expect((data as { id: string }[]).some((t) => t.id === teacher.id)).toBe(true);
      });

      it("can resolve a flag outside any region of its own", async () => {
        // Re-opened each time so all three roles get a live flag to close.
        await admin.from("flags").update({ resolved_at: null, resolved_by: null }).eq("id", flagId);
        // p_reason became mandatory in 0076 — a flag can no longer be closed
        // without saying why, which is the whole point of that migration.
        const { error } = await globals[role].client.rpc("resolve_flag", {
          p_flag_id: flagId,
          p_reason: "forgot",
          p_notes: `Resolved by ${role}`,
        });
        expect(error).toBeNull();
      });
    });
  }

  // The teacher's own access must be untouched by all of this.
  it("still shows a teacher their own class and nothing else", async () => {
    const { data: own } = await teacher.client.from("calendar_events").select("id").eq("id", eventId);
    expect(own).toHaveLength(1);
    const { data: flags } = await teacher.client.from("flags").select("id").eq("id", flagId);
    expect(flags).toHaveLength(0);
  });

  // YMU asked whether "My teachers" was Central-only. It never was — the label
  // just names the author's own region. This proves it for a South RM.
  it("gives any Regional Manager an own-teachers audience, not just Central's", async () => {
    const { data, error } = await southRm.client.rpc("create_news_post", {
      p_title: "South only",
      p_body: "Proving the audience is not hard-coded to one region.",
      p_pinned: false,
      p_notify: false,
      p_attachments: [],
      p_audience: "own_teachers",
    });
    expect(error).toBeNull();
    const post = data as { id: string; audience: string; audience_region: string };
    expect(post.audience).toBe("own_teachers");
    expect(post.audience_region).toBe("south");
    await admin.from("news_posts").delete().eq("id", post.id);
  });
});
