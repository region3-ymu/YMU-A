// Hosted integration tests for multi-calendar sync: calendar_sync_issues
// visibility and resolve_calendar_issue()'s role/region gating and the
// double-claim guard. Same disposable-user pattern as events-rls.test.ts.

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

describe.runIf(configured)("calendar sync issue RLS and resolve_calendar_issue", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdIssueIds: string[] = [];

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `calendar-sync-rls-${randomUUID()}@example.com`;
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

  async function createSchool(name: string, region: "central" | "east" | null) {
    const { data, error } = await admin
      .from("schools")
      .insert({ name, address: `${name} address`, region })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createSchool failed: ${error?.message}`);
    createdSchoolIds.push(data.id);
    return data.id as string;
  }

  async function createIssue(calendarId: string, summary: string) {
    const { data, error } = await admin
      .from("calendar_sync_issues")
      .insert({ calendar_id: calendarId, calendar_summary: summary, reason: "no_matching_school" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`createIssue failed: ${error?.message}`);
    createdIssueIds.push(data.id);
    return data.id as string;
  }

  let teacher: TestUser;
  let rmCentral: TestUser;
  let om: TestUser;
  let centralSchoolId: string;
  let eastSchoolId: string;
  let claimedSchoolId: string;
  let openIssueId: string;

  beforeAll(async () => {
    [teacher, rmCentral, om] = await Promise.all([
      createUser("Teacher"),
      createUser("RM Central"),
      createUser("Operations Manager"),
    ]);
    await Promise.all([
      setRole(rmCentral.id, "regional_manager", "central"),
      setRole(om.id, "operations_manager"),
    ]);
    [centralSchoolId, eastSchoolId, claimedSchoolId] = await Promise.all([
      createSchool("Calendar Central School", "central"),
      createSchool("Calendar East School", "east"),
      createSchool("Already Claimed School", "central"),
    ]);
    const { error: claimError } = await admin
      .from("schools")
      .update({ google_calendar_id: "already-claimed-calendar", calendar_match_source: "fuzzy" })
      .eq("id", claimedSchoolId);
    if (claimError) throw new Error(`pre-claiming a calendar failed: ${claimError.message}`);
    openIssueId = await createIssue("unmatched-calendar-1", "Some Random Calendar");
  }, 60_000);

  afterAll(async () => {
    if (createdIssueIds.length) await admin.from("calendar_sync_issues").delete().in("id", createdIssueIds);
    if (createdSchoolIds.length) await admin.from("schools").delete().in("id", createdSchoolIds);
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }, 60_000);

  it("a teacher cannot see calendar sync issues", async () => {
    const { data } = await teacher.client.from("calendar_sync_issues").select("id");
    expect(data ?? []).toHaveLength(0);
  });

  it("a regional manager sees the shared unmatched-calendar queue (not region-scoped)", async () => {
    const { data } = await rmCentral.client.from("calendar_sync_issues").select("id");
    const ids = (data ?? []).map((issue) => issue.id);
    expect(ids).toContain(openIssueId);
  });

  it("an operations manager sees the queue too", async () => {
    const { data } = await om.client.from("calendar_sync_issues").select("id");
    const ids = (data ?? []).map((issue) => issue.id);
    expect(ids).toContain(openIssueId);
  });

  it("a manager cannot bypass resolve_calendar_issue with a raw UPDATE on the pinned columns", async () => {
    const { error } = await rmCentral.client
      .from("schools")
      .update({ google_calendar_id: "sneaky-direct-write" })
      .eq("id", centralSchoolId);
    expect(error).not.toBeNull();
  });

  it("a teacher cannot call resolve_calendar_issue", async () => {
    const { error } = await teacher.client.rpc("resolve_calendar_issue", {
      p_calendar_id: "unmatched-calendar-1",
      p_school_id: centralSchoolId,
    });
    expect(error).not.toBeNull();
  });

  it("a regional manager cannot link a calendar to a school in another region", async () => {
    const { error } = await rmCentral.client.rpc("resolve_calendar_issue", {
      p_calendar_id: "unmatched-calendar-1",
      p_school_id: eastSchoolId,
    });
    expect(error).not.toBeNull();
  });

  it("a regional manager can link an open calendar to a school in their own region, resolving the issue", async () => {
    const { error } = await rmCentral.client.rpc("resolve_calendar_issue", {
      p_calendar_id: "unmatched-calendar-1",
      p_school_id: centralSchoolId,
    });
    expect(error).toBeNull();

    const { data: school } = await om.client
      .from("schools")
      .select("google_calendar_id, calendar_match_source")
      .eq("id", centralSchoolId)
      .single();
    expect(school?.google_calendar_id).toBe("unmatched-calendar-1");
    expect(school?.calendar_match_source).toBe("manual");

    const { data: issue } = await om.client
      .from("calendar_sync_issues")
      .select("resolved_at")
      .eq("id", openIssueId)
      .single();
    expect(issue?.resolved_at).not.toBeNull();
  });

  it("linking a calendar already claimed by another school fails with a friendly error", async () => {
    await createIssue("already-claimed-calendar", "Duplicate Claim Calendar");
    const { error } = await om.client.rpc("resolve_calendar_issue", {
      p_calendar_id: "already-claimed-calendar",
      p_school_id: eastSchoolId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already linked/i);
  });

  it("an operations manager can dismiss an issue with no school (not a school calendar)", async () => {
    const dismissIssueId = await createIssue("holidays-calendar", "Holidays");
    const { error } = await om.client.rpc("resolve_calendar_issue", { p_calendar_id: "holidays-calendar" });
    expect(error).toBeNull();

    const { data: issue } = await om.client
      .from("calendar_sync_issues")
      .select("resolved_at")
      .eq("id", dismissIssueId)
      .single();
    expect(issue?.resolved_at).not.toBeNull();
  });
});
