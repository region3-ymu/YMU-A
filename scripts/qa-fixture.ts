// Throwaway QA fixture for verifying the 24-hour feedback window (migration
// 0026) against real screens.
//
// The states this exercises — feedback owed but not due, feedback overdue and
// blocking, a session still open — cannot be reached by clicking around: they
// need attendance_sessions rows with specific timestamps. So this inserts them
// directly, which is fine because it is verifying the RENDERING and the SQL
// gate, not clock_in()'s own validation.
//
//   node --env-file=.env.local scripts/qa-fixture.ts up
//   node --env-file=.env.local scripts/qa-fixture.ts down
//
// Everything it creates is namespaced with QA_TAG and `down` removes all of
// it. Nothing here touches a real teacher, a real school, or a real class.
//
// The QA school deliberately has google_calendar_id = null, so the calendar
// sync ignores it entirely (syncOneCalendar only walks schools that are pinned
// to a Google calendar) and cannot overwrite or delete the fixture events.

import { createClient } from "@supabase/supabase-js";

const QA_TAG = "ZZ-QA-VERIFY";
const QA_CALENDAR_ID = "qa-verify@local";
const QA_PASSWORD = "qa-verify-2026";

const ACCOUNTS = [
  { email: "qa-teacher@ymu.test", fullName: `${QA_TAG} Teacher`, role: "teacher", region: null },
  { email: "qa-manager@ymu.test", fullName: `${QA_TAG} Manager`, role: "operations_manager", region: null },
] as const;

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before running.`);
    process.exit(1);
  }
  return value;
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HOUR = 60 * 60 * 1000;

async function findUserByEmail(email: string) {
  // listUsers is paginated; the QA accounts sort unpredictably among 50+ real
  // ones, so page through rather than trusting the first page.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function up() {
  // 1. Accounts. app_metadata.app_role and profiles.role are set together —
  //    the proxy reads the JWT claim, the DAL reads the table, and setting one
  //    without the other is the stale-JWT trap onboard-real-users.ts documents.
  const ids: Record<string, string> = {};
  for (const acct of ACCOUNTS) {
    let user = await findUserByEmail(acct.email);
    if (!user) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: acct.email,
        password: QA_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: acct.fullName },
        app_metadata: { app_role: acct.role },
      });
      if (error) throw new Error(`${acct.email}: ${error.message}`);
      user = data.user;
    } else {
      await supabase.auth.admin.updateUserById(user.id, {
        password: QA_PASSWORD,
        app_metadata: { app_role: acct.role },
      });
    }
    ids[acct.role] = user!.id;
    await supabase.from("profiles").update({
      full_name: acct.fullName,
      role: acct.role,
      region: acct.region,
    }).eq("id", user!.id);
    console.log(`  account ${acct.email} (${acct.role})`);
  }

  const teacherId = ids.teacher;

  // 2. A school of its own, so no real school's geofence or calendar pin is
  //    touched. Coordinates are YMU's actual downtown area so the map renders
  //    somewhere sensible rather than off the coast of Africa.
  // schools.name carries no unique constraint (two districts really can run a
  // same-named site), so this is select-then-insert rather than an upsert.
  let schoolId: string;
  const { data: existingSchool } = await supabase
    .from("schools").select("id").eq("name", `${QA_TAG} School`).maybeSingle();
  if (existingSchool) {
    schoolId = existingSchool.id;
  } else {
    const { data: school, error: schoolErr } = await supabase.from("schools").insert({
      name: `${QA_TAG} School`,
      address: "1 QA Way, Miami, FL",
      region: "central",
      lat: 25.7743,
      lng: -80.1937,
      geofence_radius_m: 150,
    }).select("id").single();
    if (schoolErr) throw new Error(`school: ${schoolErr.message}`);
    schoolId = school.id;
  }
  console.log(`  school ${QA_TAG} School`);

  // 3. Three classes, all in the past, one per state we need to see.
  const now = Date.now();
  const events = [
    { key: "open", startOffset: -2 * HOUR, endOffset: -1 * HOUR, summary: `${QA_TAG} Open session` },
    { key: "owed", startOffset: -6 * HOUR, endOffset: -5 * HOUR, summary: `${QA_TAG} Feedback owed` },
    { key: "overdue", startOffset: -30 * HOUR, endOffset: -29 * HOUR, summary: `${QA_TAG} Feedback overdue` },
  ];

  const eventIds: Record<string, string> = {};
  for (const e of events) {
    const { data, error } = await supabase.from("calendar_events").upsert({
      calendar_id: QA_CALENDAR_ID,
      google_event_id: `qa-${e.key}`,
      summary: e.summary,
      start_at: new Date(now + e.startOffset).toISOString(),
      end_at: new Date(now + e.endOffset).toISOString(),
      all_day: false,
      status: "confirmed",
      teacher_ids: [teacherId],
      school_id: schoolId,
      school_match_source: "manual",
    }, { onConflict: "calendar_id,google_event_id" }).select("id").single();
    if (error) throw new Error(`event ${e.key}: ${error.message}`);
    eventIds[e.key] = data.id;
    console.log(`  event ${e.summary}`);
  }

  // 4. The sessions. feedback_due_at is set explicitly rather than derived,
  //    because the whole point is to place one row either side of the 24-hour
  //    line and watch the UI and the SQL gate agree about it.
  const sessions = [
    {
      key: "open",
      clock_out_at: null,
      feedback_due_at: new Date(now + 23 * HOUR).toISOString(),
      scheduled_end_at: new Date(now - 1 * HOUR).toISOString(),
    },
    {
      key: "owed",
      clock_out_at: new Date(now - 5 * HOUR).toISOString(),
      feedback_due_at: new Date(now + 19 * HOUR).toISOString(),
      scheduled_end_at: new Date(now - 5 * HOUR).toISOString(),
    },
    {
      key: "overdue",
      clock_out_at: new Date(now - 29 * HOUR).toISOString(),
      feedback_due_at: new Date(now - 5 * HOUR).toISOString(),
      scheduled_end_at: new Date(now - 29 * HOUR).toISOString(),
    },
  ];

  // attendance_one_session_per_teacher_event (0026) is a PARTIAL unique index,
  // and PostgREST cannot use one as an ON CONFLICT target without its
  // predicate. Delete-then-insert keeps the script re-runnable.
  await supabase.from("attendance_sessions").delete().eq("teacher_id", teacherId);

  for (const s of sessions) {
    const { error } = await supabase.from("attendance_sessions").insert({
      teacher_id: teacherId,
      event_id: eventIds[s.key],
      school_id: schoolId,
      clock_in_at: new Date(now + (s.key === "overdue" ? -30 * HOUR : s.key === "owed" ? -6 * HOUR : -2 * HOUR)).toISOString(),
      clock_in_status: s.key === "owed" ? "late" : "on_time",
      scheduled_start_at: new Date(now + (s.key === "overdue" ? -30 * HOUR : s.key === "owed" ? -6 * HOUR : -2 * HOUR)).toISOString(),
      scheduled_end_at: s.scheduled_end_at,
      feedback_due_at: s.feedback_due_at,
      clock_out_at: s.clock_out_at,
      clock_out_source: s.clock_out_at ? "teacher" : null,
      origin: "online",
    }).select("id");
    if (error) throw new Error(`session ${s.key}: ${error.message}`);
    console.log(`  session ${s.key}`);
  }

  console.log(`\nQA teacher : qa-teacher@ymu.test / ${QA_PASSWORD}`);
  console.log(`QA manager : qa-manager@ymu.test / ${QA_PASSWORD}`);
}

async function down() {
  const { data: school } = await supabase.from("schools").select("id").eq("name", `${QA_TAG} School`).maybeSingle();

  // Order matters: sessions reference events and schools, gps_checks and flags
  // reference sessions. Delete inward-out rather than relying on cascade,
  // which is SET NULL on several of these and would orphan rows instead.
  if (school) {
    // Tickets and feedback_submissions first. tickets.school_id and
    // .session_id are both ON DELETE SET NULL, so deleting the school or its
    // sessions would leave orphaned tickets behind rather than removing them —
    // and an orphan with no school is invisible to every region-scoped inbox.
    const { data: tickets } = await supabase.from("tickets").select("id").eq("school_id", school.id);
    const ticketIds = (tickets ?? []).map((t) => t.id);
    if (ticketIds.length) {
      await supabase.from("ticket_messages").delete().in("ticket_id", ticketIds);
      await supabase.from("tickets").delete().in("id", ticketIds);
    }
    console.log(`  deleted ${ticketIds.length} ticket(s)`);

    const { data: sessions } = await supabase.from("attendance_sessions").select("id").eq("school_id", school.id);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    if (sessionIds.length) {
      await supabase.from("feedback_submissions").delete().in("session_id", sessionIds);
      await supabase.from("gps_checks").delete().in("session_id", sessionIds);
      await supabase.from("flags").delete().in("session_id", sessionIds);
      await supabase.from("clock_in_attempts").delete().in("session_id", sessionIds);
    }
    await supabase.from("attendance_sessions").delete().eq("school_id", school.id);
    console.log(`  deleted ${sessionIds.length} session(s)`);
  }

  await supabase.from("notification_queue").delete().eq("type", "late_clock_in").like("payload->>school_name", `${QA_TAG}%`);
  await supabase.from("calendar_events").delete().eq("calendar_id", QA_CALENDAR_ID);
  console.log("  deleted QA events");

  if (school) {
    await supabase.from("flags").delete().eq("school_id", school.id);
    await supabase.from("schools").delete().eq("id", school.id);
    console.log("  deleted QA school");
  }

  for (const acct of ACCOUNTS) {
    const user = await findUserByEmail(acct.email);
    if (user) {
      await supabase.auth.admin.deleteUser(user.id);
      console.log(`  deleted ${acct.email}`);
    }
  }
}

const mode = process.argv[2];
if (mode !== "up" && mode !== "down") {
  console.error("Usage: node --env-file=.env.local scripts/qa-fixture.ts <up|down>");
  process.exit(1);
}
await (mode === "up" ? up() : down());
console.log(`\nQA fixture ${mode} complete.`);
