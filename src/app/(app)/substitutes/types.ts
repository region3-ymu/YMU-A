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
};

export type FindResult =
  | { ok: true; candidates: Candidate[] }
  | { ok: false; error: string };
