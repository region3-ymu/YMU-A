import type { Region } from "@/lib/auth/roles";

/** A class that could need covering, for the picker. */
export type CoverableClass = {
  id: string;
  summary: string | null;
  startAt: string;
  endAt: string;
  schoolId: string;
  schoolName: string;
  region: Region | null;
  /** Names of the teachers currently on it — who would be out. */
  assignedTeachers: string[];
  /**
   * Their ids, index-for-index with assignedTeachers. Needed because a
   * substitution records WHICH teacher is away: a co-taught class has two
   * matched teachers and only one of them is absent, and Google has no
   * primary/substitute distinction to infer it from.
   */
  assignedTeacherIds: string[];
  /** Resolved from the title with the same matcher the rest of the app uses. */
  program: string | null;
};

/** One row of find_substitutes(), as the RPC returns it. */
export type Candidate = {
  teacher_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  regions: string[];
  programs: string[];
  same_region: boolean;
  same_program: boolean;
  score: number;
  /**
   * Minutes late this teacher would arrive to the class, given whatever they
   * teach immediately before at a different school — 0 means on time.
   * find_substitutes() only offers a candidate up to 15 here; never late
   * leaving, only (optionally) late arriving.
   */
  late_minutes: number;
};

export type FindResult =
  | { ok: true; candidates: Candidate[] }
  | { ok: false; error: string };

/**
 * One recorded substitution, as recent_substitutions() returns it. `reason` is
 * already the human label — SQL resolves it via absence_reason_label() so the
 * screen and the spreadsheet cannot disagree about wording.
 */
export type Substitution = {
  id: string;
  event_id: string;
  class_title: string | null;
  class_start_at: string;
  school_name: string | null;
  region: Region | null;
  absent_teacher_id: string;
  absent_teacher: string | null;
  substitute_teacher_id: string;
  substitute_teacher: string | null;
  substitute_email: string | null;
  reason: string | null;
  reason_notes: string | null;
  status: "confirmed" | "cancelled";
  confirmed_by: string | null;
  confirmed_at: string;
  cancel_reason: string | null;
  calendar_write_status: "manual" | "pending" | "written" | "failed";
};

export type ConfirmResult = { error?: string; success?: string } | undefined;
