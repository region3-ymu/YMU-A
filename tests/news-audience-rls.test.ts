// News audiences (migration 0071).
//
// Two invariants, and the second is the one worth the suite: a targeted post
// must reach only its own teachers, AND the push must go to exactly the people
// who can then find it on the board. A post someone is notified about but
// cannot open is worse than no notification.

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

describe.runIf(configured)("news audiences", () => {
  const admin = createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdUserIds: string[] = [];
  const createdSchoolIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdPostIds: string[] = [];

  let centralRm: TestUser;
  let asm: TestUser;
  let centralTeacher: TestUser;   // teaches a regular class in central
  let southTeacher: TestUser;     // teaches in south — must not see central's post
  let afterschoolTeacher: TestUser; // teaches an afterschool class, in south
  let centralSchoolId: string;
  let southSchoolId: string;

  async function createUser(fullName: string): Promise<TestUser> {
    const email = `news-rls-${randomUUID()}@example.com`;
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

  async function school(region: string) {
    const { data, error } = await admin
      .from("schools")
      .insert({
        name: `News Suite ${region} ${randomUUID().slice(0, 8)}`,
        address: "1 Test Way, Miami, FL",
        region,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`school insert failed: ${error?.message}`);
    createdSchoolIds.push(data.id);
    return data.id as string;
  }

  async function event(summary: string, schoolId: string, teacherId: string, hourUtc: string) {
    const { data: sy } = await admin
      .from("school_years")
      .select("start_date")
      .eq("archived", false)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const day = (sy?.start_date as string) ?? new Date().toISOString().slice(0, 10);
    const { data, error } = await admin
      .from("calendar_events")
      .insert({
        calendar_id: "news-suite@group.calendar.google.com",
        google_event_id: `news-suite-${randomUUID()}`,
        summary,
        school_id: schoolId,
        teacher_ids: [teacherId],
        start_at: `${day}T${hourUtc}:00:00Z`,
        end_at: `${day}T${Number(hourUtc) + 1}:00:00Z`,
        status: "confirmed",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`event insert failed: ${error?.message}`);
    createdEventIds.push(data.id);
    return data.id as string;
  }

  beforeAll(async () => {
    [centralRm, asm, centralTeacher, southTeacher, afterschoolTeacher] = await Promise.all([
      createUser("News Suite Central RM"),
      createUser("News Suite Afterschool Manager"),
      createUser("News Suite Central Teacher"),
      createUser("News Suite South Teacher"),
      createUser("News Suite Afterschool Teacher"),
    ]);

    await admin.from("profiles").update({ role: "regional_manager", region: "central" }).eq("id", centralRm.id);
    await admin.from("profiles").update({ role: "afterschool_manager", region: null }).eq("id", asm.id);

    centralSchoolId = await school("central");
    southSchoolId = await school("south");

    // 13:00Z = 09:00 EDT — a morning class, so not afterschool.
    await event("Drumline", centralSchoolId, centralTeacher.id, "13");
    await event("Drumline", southSchoolId, southTeacher.id, "13");
    // 19:00Z = 15:00 EDT, titled Afterschool — hers, and in SOUTH, which is
    // the point: her audience crosses regions.
    await event("Afterschool", southSchoolId, afterschoolTeacher.id, "19");
  }, 90_000);

  afterAll(async () => {
    // Backstop: deleting the post does not cascade to the queue — post_id
    // lives in the payload, not in a foreign key — so anything dropForeignFanout
    // missed would otherwise outlive the announcement it points at.
    for (const id of createdPostIds) await dropForeignFanout(id);
    if (createdUserIds.length) {
      const { data: ours } = await admin
        .from("notification_queue")
        .select("id")
        .eq("type", "news_published")
        .in("recipient_id", createdUserIds);
      const ids = (ours ?? []).map((q) => q.id as string);
      if (ids.length) await admin.from("notification_queue").delete().in("id", ids);
    }
    await admin.from("news_posts").delete().in("id", createdPostIds);
    await admin.from("calendar_events").delete().in("id", createdEventIds);
    await admin.from("schools").delete().in("id", createdSchoolIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  }, 60_000);

  /**
   * Publishes, then immediately un-queues the fan-out to everybody who is not
   * one of this suite's own users.
   *
   * p_notify has to stay true — the audience assertions below read the queue,
   * and that fan-out is the invariant worth testing. But create_news_post()
   * pushes to every active teacher in the organisation, and notify-dispatch
   * runs every minute against the real project, so on 28 August 2026 four test
   * announcements ("For everyone", "Central only", …) were delivered to 52 real
   * teachers' phones, 223 pushes across three runs. Nothing in the assertions
   * ever looks at those recipients.
   *
   * The delete lands a few hundred milliseconds after the insert, inside a
   * 60-second dispatch tick, so the window is small rather than closed. If a
   * run happens to collide with a tick, a handful of teachers get one stray
   * push — worth knowing before running this suite in the middle of a school
   * day.
   */
  async function post(author: TestUser, title: string, audience: string) {
    const { data, error } = await author.client.rpc("create_news_post", {
      p_title: title,
      p_body: "Body for the audience suite.",
      p_pinned: false,
      p_notify: true,
      p_attachments: [],
      p_audience: audience,
    });
    if (error) throw new Error(`create_news_post failed: ${error.message}`);
    const row = data as { id: string };
    createdPostIds.push(row.id);
    await dropForeignFanout(row.id);
    return row.id;
  }

  async function dropForeignFanout(postId: string) {
    const { data: queued } = await admin
      .from("notification_queue")
      .select("id, recipient_id")
      .eq("type", "news_published")
      .filter("payload->>post_id", "eq", postId);
    const foreign = (queued ?? [])
      .filter((q) => !createdUserIds.includes(q.recipient_id as string))
      .map((q) => q.id as string);
    if (foreign.length) await admin.from("notification_queue").delete().in("id", foreign);
  }

  async function canSee(user: TestUser, postId: string) {
    const { data } = await user.client.from("news_posts").select("id").eq("id", postId);
    return (data ?? []).length === 1;
  }

  async function notifiedIds(postId: string) {
    const { data } = await admin
      .from("notification_queue")
      .select("recipient_id")
      .eq("type", "news_published")
      .filter("payload->>post_id", "eq", postId);
    return new Set((data ?? []).map((r) => r.recipient_id as string));
  }

  describe("who may publish", () => {
    it("lets the afterschool manager post", async () => {
      const id = await post(asm, "Afterschool manager can post", "everyone");
      expect(await canSee(centralTeacher, id)).toBe(true);
    });

    it("still refuses a teacher", async () => {
      const { error } = await centralTeacher.client.rpc("create_news_post", {
        p_title: "Teacher should not be able to post",
        p_body: "Nope.",
        p_pinned: false,
        p_notify: false,
        p_attachments: [],
        p_audience: "everyone",
      });
      expect(error?.message ?? "").toMatch(/only a manager/i);
    });
  });

  describe("a Regional Manager's own teachers", () => {
    let postId: string;

    beforeAll(async () => {
      postId = await post(centralRm, "Central only", "own_teachers");
    });

    it("reaches its own region's teacher", async () => {
      expect(await canSee(centralTeacher, postId)).toBe(true);
    });

    it("does not reach another region's teacher", async () => {
      expect(await canSee(southTeacher, postId)).toBe(false);
    });

    it("is still visible to every manager", async () => {
      expect(await canSee(asm, postId)).toBe(true);
    });

    // The invariant that matters: pushed to exactly the people who can open it.
    it("notifies its own region's teacher and nobody else's", async () => {
      const notified = await notifiedIds(postId);
      expect(notified.has(centralTeacher.id)).toBe(true);
      expect(notified.has(southTeacher.id)).toBe(false);
      expect(notified.has(afterschoolTeacher.id)).toBe(false);
    });

    it("froze the region on the row rather than deriving it on read", async () => {
      const { data } = await admin
        .from("news_posts")
        .select("audience, audience_region, audience_afterschool")
        .eq("id", postId)
        .single();
      expect(data?.audience).toBe("own_teachers");
      expect(data?.audience_region).toBe("central");
      expect(data?.audience_afterschool).toBe(false);
    });
  });

  describe("the afterschool manager's own teachers", () => {
    let postId: string;

    beforeAll(async () => {
      postId = await post(asm, "Afterschool only", "own_teachers");
    });

    it("reaches her afterschool teacher, who is in another region entirely", async () => {
      expect(await canSee(afterschoolTeacher, postId)).toBe(true);
      expect(await notifiedIds(postId).then((s) => s.has(afterschoolTeacher.id))).toBe(true);
    });

    it("does not reach a teacher with no afterschool class", async () => {
      expect(await canSee(centralTeacher, postId)).toBe(false);
      expect(await canSee(southTeacher, postId)).toBe(false);
    });

    it("is still visible to the Regional Manager whose region it crossed", async () => {
      expect(await canSee(centralRm, postId)).toBe(true);
    });
  });

  describe("everyone", () => {
    it("reaches every teacher", async () => {
      const postId = await post(centralRm, "For everyone", "everyone");
      expect(await canSee(centralTeacher, postId)).toBe(true);
      expect(await canSee(southTeacher, postId)).toBe(true);
      expect(await canSee(afterschoolTeacher, postId)).toBe(true);
      const notified = await notifiedIds(postId);
      expect(notified.has(southTeacher.id)).toBe(true);
      expect(notified.has(afterschoolTeacher.id)).toBe(true);
    });
  });
});
