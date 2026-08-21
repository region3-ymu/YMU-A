import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { SUBSTITUTE_FINDER_ROLES, type Region } from "@/lib/auth/roles";
import { matchProgram, type ProgramRow } from "@/lib/feedback/program-match";
import SubstitutesFinder from "./substitutes-finder";
import RecentSubstitutions from "./recent-substitutions";
import type { CoverableClass, Substitution } from "./types";

export const metadata: Metadata = { title: "Substitutes" };

// How far ahead the picker offers classes. Covering an absence is short-notice
// work; a term's worth of classes would just be a longer list to scroll.
const DAYS_AHEAD = 14;

// How far back the "already arranged" list reaches. Cover is looked up after
// the fact as often as before it — a manager resolving a missed clock-in needs
// to find the substitution they booked last week.
const DAYS_BACK = 30;

export default async function SubstitutesPage() {
  const caller = await requireRole(...SUBSTITUTE_FINDER_ROLES);
  const supabase = await createClient();

  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + DAYS_AHEAD);

  // The picker is deliberately RLS-scoped: you pick a class you are responsible
  // for, so a Regional Manager sees their own region's classes here. Only the
  // search itself reaches across regions, and it does that inside
  // find_substitutes() rather than here.
  const [
    { data: events, error: eventsError },
    { data: programs, error: programsError },
    { data: substitutions },
  ] = await Promise.all([
      supabase
        .from("calendar_events")
        .select("id, summary, start_at, end_at, teacher_ids, school:schools!inner(id, name, region)")
        .neq("status", "cancelled")
        .gte("start_at", from.toISOString())
        .lt("start_at", to.toISOString())
        .order("start_at"),
      supabase
        .from("programs")
        .select("id, name, category, sort_order, match_patterns")
        .eq("active", true)
        .order("sort_order"),
      // Not SECURITY DEFINER, unlike find_substitutes: substitutions_select
      // already says who may read what, so this runs under the caller's RLS
      // and a Regional Manager sees their own region's cover.
      supabase.rpc("recent_substitutions", { p_days: DAYS_BACK }),
    ]);

  // Names for the teachers already on each class — the person who would be out.
  const teacherIds = [...new Set((events ?? []).flatMap((e) => e.teacher_ids ?? []))];
  const { data: teacherProfiles } = teacherIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", teacherIds)
    : { data: [] };
  const teacherName = new Map(
    (teacherProfiles ?? []).map((p) => [p.id as string, (p.full_name as string | null) ?? "Unknown"])
  );

  const programRows = (programs ?? []) as ProgramRow[];

  const classes: CoverableClass[] = (events ?? []).map((e) => {
    const school = e.school as unknown as { id: string; name: string; region: Region | null };
    return {
      id: e.id as string,
      summary: e.summary as string | null,
      startAt: e.start_at as string,
      endAt: e.end_at as string,
      schoolId: school.id,
      schoolName: school.name,
      region: school.region,
      assignedTeachers: (e.teacher_ids ?? []).map((id: string) => teacherName.get(id) ?? "Unknown"),
      assignedTeacherIds: (e.teacher_ids ?? []) as string[],
      program: matchProgram(e.summary as string | null, programRows)?.name ?? null,
    };
  });

  return (
    <main className="flex flex-1 flex-col gap-2 p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
        <span className="material-symbols-outlined" aria-hidden>
          person_search
        </span>
        Substitutes
      </h1>
      <p className="text-sm text-on-surface-variant">
        Pick the class that needs covering. Candidates are teachers who are free at that hour,
        ranked by whether they work the same region and teach the same program.
      </p>

      {(eventsError || programsError) && (
        <p role="alert" className="mt-4 rounded-2xl bg-error-container p-4 text-sm text-on-error-container shadow-sm">
          Couldn&apos;t load classes: {(eventsError ?? programsError)?.message}
        </p>
      )}

      <div className="mt-4">
        <SubstitutesFinder
          classes={classes}
          callerRole={caller.role}
          substitutions={(substitutions ?? []) as Substitution[]}
        />
      </div>

      <div className="mt-6">
        <RecentSubstitutions substitutions={(substitutions ?? []) as Substitution[]} />
      </div>
    </main>
  );
}
