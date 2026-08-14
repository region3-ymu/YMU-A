// RLS-scoped server reads feeding the Reports pages and CSV export route.
// attendance_period_rows and report_teacher_roster (0016_reports.sql) do
// their own authorization (see the migration's header comment) — a
// Regional Manager passing another region's teacherId back here just gets
// zero rows, the same way any other RLS-scoped read in this app degrades.

import { createClient } from "@/lib/supabase/server";
import type { ReportRow, RosterTeacher, SchoolYear } from "./types";

const REPORT_ROW_COLUMNS =
  "event_id, teacher_id, school_id, school_region, summary, start_at, end_at, " +
  "session_id, clock_in_status, clock_in_at, clock_out_at, origin, attendance_status, hours_worked";

// PostgREST caps a response at max_rows (1000 for this project). An
// unpaginated select does not error when it hits that ceiling — it just
// returns the first page, so a report would quietly show the earliest 1000
// classes and present the total as if it were complete. Wrong numbers that
// look right are the worst kind, so the rows are pulled a page at a time until
// a short page proves the end was reached.
const REPORT_PAGE_SIZE = 1000;
// A backstop against an unbounded range on a table that grows all year. Far
// above any real report; if it ever trips, the log line below says so rather
// than the report silently lying.
const REPORT_MAX_PAGES = 50;

export async function getReportRows(opts: {
  teacherId?: string;
  from?: string;
  to?: string;
} = {}): Promise<ReportRow[]> {
  const supabase = await createClient();
  const all: ReportRow[] = [];

  for (let page = 0; page < REPORT_MAX_PAGES; page++) {
    let query = supabase.from("attendance_period_rows").select(REPORT_ROW_COLUMNS);
    if (opts.teacherId) query = query.eq("teacher_id", opts.teacherId);
    if (opts.from) query = query.gte("start_at", opts.from);
    if (opts.to) query = query.lte("start_at", opts.to);

    const { data, error } = await query
      // Tie-broken by event_id: `start_at` alone is not unique (a school runs
      // several classes at the same hour), and an unstable sort across pages
      // would drop and duplicate rows at the page boundary.
      .order("start_at", { ascending: true })
      .order("event_id", { ascending: true })
      .range(page * REPORT_PAGE_SIZE, (page + 1) * REPORT_PAGE_SIZE - 1);

    if (error) {
      // Previously swallowed, which made a broken query indistinguishable from
      // a teacher with no classes.
      console.error(`[reports] attendance_period_rows page ${page} failed: ${error.message}`);
      break;
    }
    const rows = (data as unknown as ReportRow[]) ?? [];
    all.push(...rows);
    if (rows.length < REPORT_PAGE_SIZE) return all;
  }

  console.error(
    `[reports] stopped after ${REPORT_MAX_PAGES} pages — the report may be incomplete. Narrow the range.`,
  );
  return all;
}

export async function getReportRoster(includeArchived = false): Promise<RosterTeacher[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("report_teacher_roster", {
    p_include_archived: includeArchived,
  });
  const roster = (data as RosterTeacher[]) ?? [];
  return roster.slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function getSchoolYears(): Promise<SchoolYear[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("school_years")
    .select("id, name, start_date, end_date, archived")
    .order("start_date", { ascending: false });
  return (data as SchoolYear[]) ?? [];
}
