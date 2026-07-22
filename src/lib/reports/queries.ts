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

export async function getReportRows(opts: {
  teacherId?: string;
  from?: string;
  to?: string;
} = {}): Promise<ReportRow[]> {
  const supabase = await createClient();
  let query = supabase.from("attendance_period_rows").select(REPORT_ROW_COLUMNS);
  if (opts.teacherId) query = query.eq("teacher_id", opts.teacherId);
  if (opts.from) query = query.gte("start_at", opts.from);
  if (opts.to) query = query.lte("start_at", opts.to);
  const { data } = await query.order("start_at", { ascending: true });
  return (data as unknown as ReportRow[]) ?? [];
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
