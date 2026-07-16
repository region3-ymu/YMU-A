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

  return (
    <div className="flex flex-col gap-8">
      <AddSchoolForm />

      <div className="flex flex-col gap-1">
        <label htmlFor="lists-search" className="text-sm font-medium">
          Search schools &amp; teachers
        </label>
        <input
          id="lists-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, address, email, phone…"
          className="rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          Schools <span className="text-sm font-normal opacity-60">({filteredSchools.length})</span>
        </h2>
        {filteredSchools.length === 0 ? (
          <p className="text-sm opacity-60">No schools match.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {filteredSchools.map((school) => (
              <SchoolCard key={school.id} school={school} callerRole={callerRole} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          Teachers <span className="text-sm font-normal opacity-60">({filteredTeachers.length})</span>
        </h2>
        <p className="text-xs opacity-60">
          Grouped by region for now — per-school rosters arrive once Google
          Calendar sync (Phase 3) links teachers to schools via their
          scheduled events.
        </p>
        {filteredTeachers.length === 0 ? (
          <p className="text-sm opacity-60">No teachers match.</p>
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
