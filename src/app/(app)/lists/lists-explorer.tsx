"use client";

import { useMemo, useState } from "react";
import type { AppRole } from "@/lib/auth/roles";
import AddSchoolForm from "./add-school-form";
import SchoolCard from "./school-card";
import TeacherPopover from "./teacher-popover";
import type { School, Teacher } from "./types";

function matches(haystacks: (string | null)[], needle: string): boolean {
  return haystacks.some((value) => value?.toLowerCase().includes(needle));
}

export default function ListsExplorer({
  schools,
  teachers,
  callerRole,
}: {
  schools: School[];
  teachers: Teacher[];
  callerRole: AppRole;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  // Per-school map collapse state, lifted here so one "Hide/Show maps" button
  // can act on every visible card at once, while a single card can still be
  // reopened afterward without re-expanding the rest (see toggleSchoolMap).
  const [collapsedMapIds, setCollapsedMapIds] = useState<Set<string>>(() => new Set());

  const filteredSchools = useMemo(
    () =>
      needle
        ? schools.filter((school) =>
            matches(
              [school.name, school.address, school.contact_name, school.contact_phone],
              needle,
            ),
          )
        : schools,
    [schools, needle],
  );

  const filteredTeachers = useMemo(
    () =>
      needle
        ? teachers.filter((teacher) =>
            matches([teacher.full_name, teacher.email, teacher.phone], needle),
          )
        : teachers,
    [teachers, needle],
  );

  const allMapsCollapsed =
    filteredSchools.length > 0 && filteredSchools.every((school) => collapsedMapIds.has(school.id));

  function toggleAllMaps() {
    setCollapsedMapIds(
      allMapsCollapsed ? new Set() : new Set(filteredSchools.map((school) => school.id)),
    );
  }

  function toggleSchoolMap(schoolId: string) {
    setCollapsedMapIds((prev) => {
      const next = new Set(prev);
      if (next.has(schoolId)) next.delete(schoolId);
      else next.add(schoolId);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <AddSchoolForm />

      <div className="flex flex-col gap-1">
        <label htmlFor="lists-search" className="text-sm font-medium text-on-surface">
          Search schools &amp; teachers
        </label>
        <div className="relative">
          <span
            className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
            aria-hidden
          >
            search
          </span>
          <input
            id="lists-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, address, email, phone…"
            className="w-full rounded-full bg-surface-container-low py-2.5 pl-11 pr-4 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-on-surface">
            Schools{" "}
            <span className="text-sm font-normal text-on-surface-variant">({filteredSchools.length})</span>
          </h2>
          {filteredSchools.length > 0 && (
            <button
              type="button"
              onClick={toggleAllMaps}
              className="rounded-full border-2 border-outline px-3 py-1 text-xs font-bold text-on-surface"
            >
              {allMapsCollapsed ? "Show maps" : "Hide maps"}
            </button>
          )}
        </div>
        {filteredSchools.length === 0 ? (
          <p className="rounded-2xl bg-surface-container p-6 text-center text-sm text-on-surface-variant shadow-sm">
            No schools match.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {filteredSchools.map((school) => (
              <SchoolCard
                key={school.id}
                school={school}
                callerRole={callerRole}
                mapCollapsed={collapsedMapIds.has(school.id)}
                onToggleMap={() => toggleSchoolMap(school.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-on-surface">
          Teachers{" "}
          <span className="text-sm font-normal text-on-surface-variant">({filteredTeachers.length})</span>
        </h2>
        <p className="text-xs text-on-surface-variant">
          Grouped by region for now — per-school rosters arrive once Google
          Calendar sync (Phase 3) links teachers to schools via their
          scheduled events.
        </p>
        {filteredTeachers.length === 0 ? (
          <p className="rounded-2xl bg-surface-container p-6 text-center text-sm text-on-surface-variant shadow-sm">
            No teachers match.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filteredTeachers.map((teacher) => (
              <li key={teacher.id}>
                <TeacherPopover teacher={teacher} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
