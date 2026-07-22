// QA seed for manual end-to-end testing. Bootstraps one account per role, a
// test school pinned at a configurable location, a school year, and a calendar
// event the seeded teacher can clock into — so the whole "Part 0" testing
// setup is one command instead of the sign-up + SQL-promote + re-login dance
// (see NEXT_STEPS.md / the review plan).
//
//   SEED_ALLOW=1 npm run seed:test
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local
// (via --env-file in the npm script) and runs against whatever project those
// point at, using the service-role key. It is a hard error to run without
// SEED_ALLOW=1 so this can never fire by accident against production.
//
// Idempotent: re-running updates the same fixed accounts/rows rather than
// duplicating them. It never deletes anything.
//
// Optional env:
//   SEED_PASSWORD      password for every seeded account (default below; must be >=8)
//   SEED_TEST_LAT/LNG  where to pin the test school (default: downtown Miami)
//   SEED_TEST_RADIUS_M geofence radius in meters (default 100000 — deliberately
//                      wide so clock-in works without exact GPS; NOT production-like)
//
// Runs under Node's native TypeScript stripping (Node 22.6+/24); no build step.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Role = "teacher" | "regional_manager" | "operations_manager" | "cpo";

const SEED_REGION = "central";
const SEED_SCHOOL_NAME = "Seed Test School";
const SEED_YEAR_NAME = "Seed Test Year";
const SEED_CALENDAR_ID = "seed-test-calendar";
const SEED_EVENT_GID = "seed-test-event-1";

const ACCOUNTS: { role: Role; email: string; fullName: string }[] = [
  { role: "teacher", email: "teacher@ymu.test", fullName: "Seed Teacher" },
  { role: "regional_manager", email: "rm@ymu.test", fullName: "Seed Regional Manager" },
  { role: "operations_manager", email: "om@ymu.test", fullName: "Seed Operations Manager" },
  { role: "cpo", email: "cpo@ymu.test", fullName: "Seed CPO" },
];

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in .env.local before seeding.`);
    process.exit(1);
  }
  return value;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Build an email -> id map once so re-runs find already-created users instead
// of failing on "email already registered".
async function loadExistingUsers(admin: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const u of data.users) if (u.email) map.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 1000) break;
  }
  return map;
}

async function main() {
  if (process.env.SEED_ALLOW !== "1") {
    console.error(
      "Refusing to seed without SEED_ALLOW=1.\n" +
        "This writes test accounts/data to the project in .env.local. If that is a\n" +
        "safe (non-production) project, re-run:  SEED_ALLOW=1 npm run seed:test",
    );
    process.exit(1);
  }

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const password = process.env.SEED_PASSWORD?.trim() || "YmuTest123!";
  if (password.length < 8) {
    console.error("SEED_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }
  const lat = num("SEED_TEST_LAT", 25.7617);
  const lng = num("SEED_TEST_LNG", -80.1918);
  const radiusM = Math.round(num("SEED_TEST_RADIUS_M", 100000));

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Seeding test data into ${url} …`);
  const existing = await loadExistingUsers(admin);
  const ids: Record<Role, string> = {} as Record<Role, string>;

  // 1. Accounts — create if missing, then set role + region on BOTH profiles
  //    and the auth JWT claim so a fresh login lands with the right access
  //    (no re-login trap: current_app_role() reads profiles, the proxy reads
  //    the JWT app_role — set both).
  for (const acct of ACCOUNTS) {
    let id = existing.get(acct.email.toLowerCase());
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({
        email: acct.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: acct.fullName },
      });
      if (error || !data.user) throw new Error(`createUser(${acct.email}) failed: ${error?.message}`);
      id = data.user.id;
    } else {
      // Keep the password predictable across re-runs / manual changes.
      await admin.auth.admin.updateUserById(id, { password });
    }
    ids[acct.role] = id;

    const region = acct.role === "regional_manager" ? SEED_REGION : null;
    const { error: profErr } = await admin.from("profiles").update({ role: acct.role, region }).eq("id", id);
    if (profErr) throw new Error(`profiles.update(${acct.email}) failed: ${profErr.message}`);

    const { error: metaErr } = await admin.auth.admin.updateUserById(id, {
      app_metadata: { app_role: acct.role },
    });
    if (metaErr) throw new Error(`updateUserById app_metadata(${acct.email}) failed: ${metaErr.message}`);
    console.log(`  ✓ ${acct.role.padEnd(18)} ${acct.email}`);
  }

  // 2. Test school pinned at the configured location (idempotent by name).
  const { data: schoolRows, error: schoolSelErr } = await admin
    .from("schools")
    .select("id")
    .eq("name", SEED_SCHOOL_NAME)
    .limit(1);
  if (schoolSelErr) throw new Error(`schools select failed: ${schoolSelErr.message}`);
  const schoolPayload = {
    name: SEED_SCHOOL_NAME,
    address: "123 Test Ave (seed)",
    lat,
    lng,
    geocode_source: "manual",
    geofence_radius_m: radiusM,
    region: SEED_REGION,
    contact_name: "Seed Contact",
    contact_phone: "+13055551234",
  };
  let schoolId: string;
  if (schoolRows && schoolRows.length > 0) {
    schoolId = schoolRows[0].id;
    const { error } = await admin.from("schools").update(schoolPayload).eq("id", schoolId);
    if (error) throw new Error(`schools update failed: ${error.message}`);
  } else {
    const { data, error } = await admin.from("schools").insert(schoolPayload).select("id").single();
    if (error || !data) throw new Error(`schools insert failed: ${error?.message}`);
    schoolId = data.id;
  }
  console.log(`  ✓ school "${SEED_SCHOOL_NAME}" @ ${lat},${lng} r=${radiusM}m (${schoolId})`);

  // 3. First school year (idempotent by name).
  const { data: yearRows } = await admin.from("school_years").select("id").eq("name", SEED_YEAR_NAME).limit(1);
  const year = new Date().getUTCFullYear();
  const yearPayload = {
    name: SEED_YEAR_NAME,
    start_date: `${year}-08-01`,
    end_date: `${year + 1}-06-30`,
    archived: false,
  };
  if (yearRows && yearRows.length > 0) {
    await admin.from("school_years").update(yearPayload).eq("id", yearRows[0].id);
  } else {
    const { error } = await admin.from("school_years").insert(yearPayload);
    if (error) throw new Error(`school_years insert failed: ${error.message}`);
  }
  console.log(`  ✓ school year "${SEED_YEAR_NAME}"`);

  // 4. A calendar event the seeded teacher can clock into (starts in 5 min so
  //    it's the "next class"; upsert on the (calendar_id, google_event_id) key).
  const now = Date.now();
  const startAt = new Date(now + 5 * 60_000).toISOString();
  const endAt = new Date(now + 65 * 60_000).toISOString();
  const { error: eventErr } = await admin.from("calendar_events").upsert(
    {
      calendar_id: SEED_CALENDAR_ID,
      google_event_id: SEED_EVENT_GID,
      summary: "Seed Test Class",
      location_raw: SEED_SCHOOL_NAME,
      start_at: startAt,
      end_at: endAt,
      all_day: false,
      status: "confirmed",
      teacher_ids: [ids.teacher],
      school_id: schoolId,
      school_match_source: "manual",
      synced_at: new Date(now).toISOString(),
    },
    { onConflict: "calendar_id,google_event_id" },
  );
  if (eventErr) throw new Error(`calendar_events upsert failed: ${eventErr.message}`);
  console.log(`  ✓ calendar event "Seed Test Class" for the teacher, starts ${startAt}`);

  const webhookSecret = process.env.ZOHO_FEEDBACK_WEBHOOK_SECRET?.trim() || "<ZOHO_FEEDBACK_WEBHOOK_SECRET>";
  console.log(`
Done. Log in to your app (e.g. https://ymu-a-navy.vercel.app) with:
  Accounts (password: ${password}):
    teacher@ymu.test  · rm@ymu.test  · om@ymu.test  · cpo@ymu.test

Notes:
  • The test school has a ${radiusM} m geofence so clock-in works without exact
    GPS. Set SEED_TEST_LAT/SEED_TEST_LNG to your own coordinates (and re-run) for
    a realistic radius, or narrow SEED_TEST_RADIUS_M to test the out-of-fence path.
  • To simulate the Zoho webhook closing the teacher's OPEN session (get its id
    from the teacher's open session / attendance_sessions):

    curl -X POST "<your app origin>/api/zoho-feedback" \\
      -H "content-type: application/json" \\
      -H "x-zoho-feedback-secret: ${webhookSecret}" \\
      -d '{"session_id":"<open-session-uuid>","teacher_id":"${ids.teacher}","MultipleChoice":"Very engaged","MultipleChoice1":"No","MultipleChoice2":"","MultiLine":"seed test"}'
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
