// Sets up a place for YMU staff to exercise the whole teacher flow without
// standing in a school.
//
// Creates the YMU office as a site, a teacher account for Emilio, and three
// shifts there. Re-runnable: everything upserts, and `--reset` clears the
// attendance/feedback/tickets those shifts produced so the same test can be
// run again from scratch.
//
//   node --env-file=.env.local scripts/office-test-setup.ts
//   node --env-file=.env.local scripts/office-test-setup.ts --reset
//
// The office deliberately has google_calendar_id = null, so the calendar sync
// ignores it entirely (it only walks schools pinned to a Google calendar) and
// can never overwrite or delete these events.

import { createClient } from "@supabase/supabase-js";

const OFFICE_NAME = "YMU Office (testing)";
const OFFICE_CALENDAR_ID = "ymu-office@local";
const TEACHER_EMAIL = "emiliomedranomusic@gmail.com";
const TEACHER_NAME = "Emilio Medrano (teacher test)";
const TEACHER_PHONE = "2036763842";
const TEACHER_PASSWORD = "ymu12345";

// Census-geocoded from 1584 NW 29th St, Miami, FL 33142.
const OFFICE_LAT = 25.80310681403;
const OFFICE_LNG = -80.222753138908;
// Wider than a school's default. Indoors, phone GPS routinely lands 50-100m
// off, and a test that fails on the geofence teaches nothing about the
// feature being tested.
const OFFICE_RADIUS_M = 250;

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

async function findUserByEmail(email: string) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Miami wall-clock to a UTC instant. August is EDT, UTC-4. */
function miamiToUtc(dayOffset: number, hour: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset));
  d.setUTCHours(hour + 4, 0, 0, 0);
  return d;
}

async function up() {
  // 1. The office as a site. region 'central' on purpose: that routes any
  //    ticket raised here to the Central Regional Manager, which is Emilio's
  //    own manager account — so one person can walk the full loop.
  // Find-then-write rather than upsert: schools.name carries no unique index
  // (only id and google_calendar_id do), so ON CONFLICT (name) is rejected
  // outright by Postgres.
  const fields = {
    name: OFFICE_NAME,
    address: "1584 NW 29th St, Miami, FL 33142",
    region: "central" as const,
    lat: OFFICE_LAT,
    lng: OFFICE_LNG,
    geofence_radius_m: OFFICE_RADIUS_M,
  };
  const { data: existing } = await supabase
    .from("schools").select("id").eq("name", OFFICE_NAME).maybeSingle();

  let school: { id: string };
  if (existing) {
    const { data, error } = await supabase
      .from("schools").update(fields).eq("id", existing.id).select("id").single();
    if (error) throw new Error(`school: ${error.message}`);
    school = data;
  } else {
    const { data, error } = await supabase.from("schools").insert(fields).select("id").single();
    if (error) throw new Error(`school: ${error.message}`);
    school = data;
  }
  console.log(`  site: ${OFFICE_NAME} (${OFFICE_RADIUS_M}m radius)`);

  // 2. A TEACHER account, separate from region3@ymu.org. One account cannot
  //    be both a teacher and a manager, and the point is to see the teacher
  //    screens.
  let user = await findUserByEmail(TEACHER_EMAIL);
  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: TEACHER_EMAIL,
      password: TEACHER_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: TEACHER_NAME },
      app_metadata: { app_role: "teacher" },
    });
    if (error) throw new Error(`${TEACHER_EMAIL}: ${error.message}`);
    user = data.user;
    console.log(`  account created: ${TEACHER_EMAIL}`);
  } else {
    await supabase.auth.admin.updateUserById(user.id, {
      password: TEACHER_PASSWORD,
      app_metadata: { app_role: "teacher" },
    });
    console.log(`  account already existed, password reset: ${TEACHER_EMAIL}`);
  }
  // Both halves: the proxy reads the JWT claim, the DAL reads the table.
  await supabase.from("profiles").update({
    full_name: TEACHER_NAME,
    role: "teacher",
    phone: TEACHER_PHONE,
    region: null,
  }).eq("id", user!.id);

  // 3. Three shifts, not one. Testing "clock into the next class while
  //    feedback is still pending" needs a second class to exist, and that is
  //    the whole point of the 24-hour window.
  const shifts = [
    { key: "today-10", day: 0, hour: 10, summary: "Drumline — YMU Office" },
    { key: "today-14", day: 0, hour: 14, summary: "Music Production — YMU Office" },
    { key: "tomorrow-10", day: 1, hour: 10, summary: "Modern Band — YMU Office" },
  ];

  for (const shift of shifts) {
    const start = miamiToUtc(shift.day, shift.hour);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const { error } = await supabase.from("calendar_events").upsert({
      calendar_id: OFFICE_CALENDAR_ID,
      google_event_id: `office-${shift.key}`,
      summary: shift.summary,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: false,
      status: "confirmed",
      teacher_ids: [user!.id],
      school_id: school.id,
      school_match_source: "manual",
      location_raw: "1584 NW 29th St, Miami, FL 33142",
    }, { onConflict: "calendar_id,google_event_id" });
    if (error) throw new Error(`event ${shift.key}: ${error.message}`);
    const label = new Intl.DateTimeFormat("en-US", {
      weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
    }).format(start);
    console.log(`  shift: ${shift.summary} — ${label} Miami`);
  }

  console.log(`\nTeacher login : ${TEACHER_EMAIL} / ${TEACHER_PASSWORD}`);
  console.log(`Manager login : region3@ymu.org (your existing account)`);
}

/** Clears what the shifts produced, so the same test can be re-run clean. */
async function reset() {
  const { data: school } = await supabase.from("schools").select("id").eq("name", OFFICE_NAME).maybeSingle();
  if (!school) {
    console.log("  nothing to reset — the office site does not exist yet.");
    return;
  }

  // Tickets first: tickets.school_id and .session_id are both ON DELETE SET
  // NULL, so removing sessions would orphan them rather than delete them, and
  // an orphan with no school is invisible to every region-scoped inbox.
  const { data: tickets } = await supabase.from("tickets").select("id").eq("school_id", school.id);
  const ticketIds = (tickets ?? []).map((t) => t.id);
  if (ticketIds.length) {
    await supabase.from("ticket_messages").delete().in("ticket_id", ticketIds);
    await supabase.from("tickets").delete().in("id", ticketIds);
  }

  const { data: sessions } = await supabase.from("attendance_sessions").select("id").eq("school_id", school.id);
  const sessionIds = (sessions ?? []).map((s) => s.id);
  if (sessionIds.length) {
    await supabase.from("feedback_submissions").delete().in("session_id", sessionIds);
    await supabase.from("gps_checks").delete().in("session_id", sessionIds);
    await supabase.from("flags").delete().in("session_id", sessionIds);
    await supabase.from("clock_in_attempts").delete().in("session_id", sessionIds);
  }
  await supabase.from("attendance_sessions").delete().eq("school_id", school.id);

  console.log(`  cleared ${ticketIds.length} ticket(s) and ${sessionIds.length} session(s).`);
  console.log("  the office site, the teacher account and the shifts are kept — run without --reset to refresh the shift times.");
}

const doReset = process.argv.includes("--reset");
await (doReset ? reset() : up());
console.log("\nDone.");
