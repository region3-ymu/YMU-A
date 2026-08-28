// The afterschool split, end to end (migrations 0062-0065).
//
// One assertion pair per table, and both halves matter: it is not enough that
// she can see an afterschool class, the Regional Manager whose region it sits
// in has to STOP seeing it. A suite that only checked her side would pass on a
// policy that leaked to both.
//
// Same disposable-user pattern as the other RLS suites.

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

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.runIf(configured)("afterschool manager scope", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];

  let rm: TestUser;          // regional_manager, region 'central'
  let asm: TestUser;         // afterschool_manager, no region
  let teacher: TestUser;
  let schoolId: string;      // in 'central', so the RM owns it
  let afterschoolEventId: string;
  let regularEventId: string;
  let sessionId: string;

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `as-rls-${randomUUID()}@example.com`;
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

  // Both classes land inside the school year now in progress, because
  // afterschool_owned() windows on it — a fixture dated last year would be
  // invisible to her no matter how it was titled, and the suite would pass for
  // the wrong reason.
  async function currentSchoolYearStart(): Promise<string> {
    const { data } = await admin
      .from("school_years")
      .select("start_date")
      .eq("archived", false)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.start_date as string) ?? new Date().toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    [rm, asm, teacher] = await Promise.all([
      createUser("AS Suite RM"),
      createUser("AS Suite Afterschool Manager"),
      createUser("AS Suite Teacher"),
    ]);

    await admin.from("profiles").update({ role: "regional_manager", region: "central" }).eq("id", rm.id);
    // No region, on purpose: that is the shape the role is meant to have.
    await admin.from("profiles").update({ role: "afterschool_manager", region: null }).eq("id", asm.id);

    const { data: school, error: schoolError } = await admin
      .from("schools")
      .insert({
        name: `AS Suite School ${randomUUID().slice(0, 8)}`,
        address: "1 Test Way, Miami, FL",
        region: "central",
      })
      .select("id")
      .single();
    if (schoolError || !school) throw new Error(`school insert failed: ${schoolError?.message}`);
    schoolId = school.id;
    createdSchoolIds.push(schoolId);

    // A weekday inside the current year, at 15:00 and 09:00 local.
    const yearStart = await currentSchoolYearStart();
    const afternoon = `${yearStart}T19:00:00Z`; // 15:00 EDT
    const morning = `${yearStart}T13:00:00Z`;   // 09:00 EDT

    const { data: events, error: eventsError } = await admin
      .from("calendar_events")
      .insert([
        {
          calendar_id: "as-suite-fixture@group.calendar.google.com",
          google_event_id: `as-suite-after-${randomUUID()}`,
          summary: "Afterschool",
          school_id: schoolId,
          teacher_ids: [teacher.id],
          start_at: afternoon,
          end_at: `${yearStart}T21:00:00Z`,
          status: "confirmed",
        },
        {
          calendar_id: "as-suite-fixture@group.calendar.google.com",
          google_event_id: `as-suite-regular-${randomUUID()}`,
          summary: "Drumline",
          school_id: schoolId,
          teacher_ids: [teacher.id],
          start_at: morning,
          end_at: `${yearStart}T14:00:00Z`,
          status: "confirmed",
        },
      ])
      .select("id, summary, is_afterschool");
    if (eventsError) throw new Error(`event insert failed: ${eventsError.message}`);

    afterschoolEventId = events!.find((e) => e.summary === "Afterschool")!.id;
    regularEventId = events!.find((e) => e.summary === "Drumline")!.id;
    createdEventIds.push(afterschoolEventId, regularEventId);

    const { data: session } = await admin
      .from("attendance_sessions")
      .insert({
        teacher_id: teacher.id,
        event_id: afterschoolEventId,
        school_id: schoolId,
        clock_in_at: afternoon,
        clock_in_status: "on_time",
        scheduled_start_at: afternoon,
      })
      .select("id")
      .single();
    sessionId = session!.id;
  }, 60_000);

  afterAll(async () => {
    await admin.from("attendance_sessions").delete().in("event_id", createdEventIds);
    await admin.from("tickets").delete().in("event_id", createdEventIds);
    await admin.from("flags").delete().in("event_id", createdEventIds);
    await admin.from("calendar_events").delete().in("id", createdEventIds);
    await admin.from("schools").delete().in("id", createdSchoolIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  }, 60_000);

  it("classifies the fixture on insert, by trigger", async () => {
    const { data } = await admin
      .from("calendar_events")
      .select("id, is_afterschool")
      .in("id", [afterschoolEventId, regularEventId]);
    const byId = new Map(data!.map((r) => [r.id, r.is_afterschool]));
    expect(byId.get(afterschoolEventId)).toBe(true);
    expect(byId.get(regularEventId)).toBe(false);
  });

  describe("calendar_events", () => {
    it("hides the afterschool class from the region's RM", async () => {
      const { data } = await rm.client.from("calendar_events").select("id").eq("id", afterschoolEventId);
      expect(data).toHaveLength(0);
    });

    it("still gives that RM the regular class in the same school", async () => {
      const { data } = await rm.client.from("calendar_events").select("id").eq("id", regularEventId);
      expect(data).toHaveLength(1);
    });

    it("gives the afterschool manager the afterschool class, with no region of her own", async () => {
      const { data } = await asm.client.from("calendar_events").select("id").eq("id", afterschoolEventId);
      expect(data).toHaveLength(1);
    });

    it("does not give her the regular class", async () => {
      const { data } = await asm.client.from("calendar_events").select("id").eq("id", regularEventId);
      expect(data).toHaveLength(0);
    });

    // The teacher branch comes first in the policy for exactly this reason:
    // they still have to clock in and still owe feedback.
    it("leaves the teacher their own afterschool class", async () => {
      const { data } = await teacher.client.from("calendar_events").select("id").eq("id", afterschoolEventId);
      expect(data).toHaveLength(1);
    });
  });

  describe("attendance_sessions", () => {
    it("hides the afterschool session from the RM and shows it to her", async () => {
      const { data: rmRows } = await rm.client.from("attendance_sessions").select("id").eq("id", sessionId);
      const { data: asmRows } = await asm.client.from("attendance_sessions").select("id").eq("id", sessionId);
      expect(rmRows).toHaveLength(0);
      expect(asmRows).toHaveLength(1);
    });
  });

  describe("flags", () => {
    let flagId: string;

    beforeAll(async () => {
      const { data } = await admin
        .from("flags")
        .insert({
          type: "late_clock_in",
          session_id: sessionId,
          event_id: afterschoolEventId,
          teacher_id: teacher.id,
          school_id: schoolId,
          details: {},
        })
        .select("id")
        .single();
      flagId = data!.id;
    });

    it("hides the afterschool flag from the RM and shows it to her", async () => {
      const { data: rmRows } = await rm.client.from("flags").select("id").eq("id", flagId);
      const { data: asmRows } = await asm.client.from("flags").select("id").eq("id", flagId);
      expect(rmRows).toHaveLength(0);
      expect(asmRows).toHaveLength(1);
    });

    it("lets her resolve it and refuses the RM", async () => {
      const { error: rmError } = await rm.client.rpc("resolve_flag", {
        p_flag_id: flagId,
        p_notes: "RM should not be able to do this",
      });
      expect(rmError?.message ?? "").toMatch(/afterschool manager/i);

      const { error: asmError } = await asm.client.rpc("resolve_flag", {
        p_flag_id: flagId,
        p_notes: "Confirmed on the sign-in sheet",
      });
      expect(asmError).toBeNull();
    });
  });

  describe("tickets", () => {
    it("assigns a new afterschool ticket to her, not to the school's RM", async () => {
      const { data, error } = await admin
        .from("tickets")
        .insert({
          teacher_id: teacher.id,
          school_id: schoolId,
          event_id: afterschoolEventId,
          region: "central",
          category_type: "Operational",
          description: "Afterschool ticket routing fixture",
          // What ticket_owner_for_school() would have chosen. The trigger has
          // to override it.
          assigned_agent_id: rm.id,
        })
        .select("id, assigned_agent_id")
        .single();
      if (error) throw new Error(`ticket insert failed: ${error.message}`);
      // Not asm.id: route_afterschool_ticket() takes the OLDEST
      // afterschool_manager, and YMU's real one (afterschool@ymu.org) predates
      // this fixture. Asserting on the fixture made the test fail the moment
      // the feature went live, which is the wrong thing to be sensitive to.
      // The invariant is that it left the RM for an afterschool manager.
      const { data: managers } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "afterschool_manager")
        .is("archived_at", null);
      const managerIds = (managers ?? []).map((m) => m.id);
      expect(data!.assigned_agent_id).not.toBe(rm.id);
      expect(managerIds).toContain(data!.assigned_agent_id);
    });

    it("leaves a regular ticket with the RM", async () => {
      const { data, error } = await admin
        .from("tickets")
        .insert({
          teacher_id: teacher.id,
          school_id: schoolId,
          event_id: regularEventId,
          region: "central",
          category_type: "Operational",
          description: "Regular ticket routing fixture",
          assigned_agent_id: rm.id,
        })
        .select("id, assigned_agent_id")
        .single();
      if (error) throw new Error(`ticket insert failed: ${error.message}`);
      expect(data!.assigned_agent_id).toBe(rm.id);
    });
  });

  describe("schools", () => {
    it("gives her the school that hosts an afterschool class", async () => {
      const { data } = await asm.client.from("schools").select("id").eq("id", schoolId);
      expect(data).toHaveLength(1);
    });
  });

  describe("profiles", () => {
    it("lets her read the afterschool teacher's name", async () => {
      const { data } = await asm.client.from("profiles").select("id, full_name").eq("id", teacher.id);
      expect(data).toHaveLength(1);
    });
  });

  // The definer functions bypass RLS and re-check the region themselves, so
  // 0064 did not reach them. report_teacher_roster() is where that showed:
  // the dashboard resolves every name through it, so "Clocked in now" and
  // "Pending feedback" read "Unknown teacher" for her (YMU 2026-08-18).
  describe("the definer functions (0070)", () => {
    it("names the afterschool teacher in report_teacher_roster", async () => {
      const { data, error } = await asm.client.rpc("report_teacher_roster", {
        p_include_archived: true,
      });
      expect(error).toBeNull();
      const row = (data as { id: string; full_name: string }[]).find((t) => t.id === teacher.id);
      expect(row?.full_name).toBe("AS Suite Teacher");
    });

    it("names them in teacher_directory too, so /lists is not empty", async () => {
      const { data, error } = await asm.client.rpc("teacher_directory");
      expect(error).toBeNull();
      expect((data as { id: string }[]).some((t) => t.id === teacher.id)).toBe(true);
    });

    it("lets her run find_substitutes on an afterschool class", async () => {
      const { error } = await asm.client.rpc("find_substitutes", {
        p_event_id: afterschoolEventId,
      });
      expect(error).toBeNull();
    });

    it("still refuses a teacher find_substitutes", async () => {
      const { error } = await teacher.client.rpc("find_substitutes", {
        p_event_id: afterschoolEventId,
      });
      expect(error?.message ?? "").toMatch(/requires a manager role/i);
    });

    // An unlinked afterschool class has no school, so no region, so no RM can
    // see it — she is the only one who can file it.
    it("lets her link an unmatched afterschool class to a school", async () => {
      const { data: orphan } = await admin
        .from("calendar_events")
        .insert({
          calendar_id: "as-suite-fixture@group.calendar.google.com",
          google_event_id: `as-suite-orphan-${randomUUID()}`,
          summary: "Afterschool",
          teacher_ids: [teacher.id],
          start_at: `${await currentSchoolYearStart()}T19:00:00Z`,
          status: "confirmed",
        })
        .select("id")
        .single();
      createdEventIds.push(orphan!.id);

      const { error } = await asm.client.rpc("assign_event_school", {
        p_event_id: orphan!.id,
        p_school_id: schoolId,
      });
      expect(error).toBeNull();
    });

    it("refuses her a regular class in assign_event_school", async () => {
      const { error } = await asm.client.rpc("assign_event_school", {
        p_event_id: regularEventId,
        p_school_id: schoolId,
      });
      expect(error?.message ?? "").toMatch(/only assign a school to an afterschool class/i);
    });

    it("refuses the RM an afterschool class in assign_event_school", async () => {
      const { error } = await rm.client.rpc("assign_event_school", {
        p_event_id: afterschoolEventId,
        p_school_id: schoolId,
      });
      expect(error?.message ?? "").toMatch(/afterschool manager/i);
    });
  });
});
