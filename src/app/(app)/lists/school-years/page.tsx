import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { getActiveSchoolYear } from "@/lib/school-years/derive";
import { getSchoolYears } from "@/lib/reports/queries";
import ArchiveYearButton from "./archive-year-button";
import CreateSchoolYearForm from "./create-school-year-form";

export const metadata: Metadata = { title: "School years" };

export default async function SchoolYearsPage() {
  await requireRole("operations_manager", "cpo");

  const schoolYears = await getSchoolYears();
  const activeYear = getActiveSchoolYear(schoolYears);

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <header>
        <Link
          href="/lists"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary"
        >
          ← Lists
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <span className="material-symbols-outlined text-primary" aria-hidden>
            school
          </span>
          School years
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Attendance/schedules link to a school year by date — no year is ever
          picked manually. Archiving a completed year only hides it from
          &ldquo;active&rdquo; status here; its reports keep generating from the
          same date range.
        </p>
      </header>

      <CreateSchoolYearForm />

      <section>
        <h2 className="mb-2 text-lg font-semibold text-on-surface">All school years</h2>
        {schoolYears.length === 0 ? (
          <p className="rounded-2xl bg-surface-container p-6 text-center text-sm text-on-surface-variant shadow-sm">
            No school years yet — create one above so quarterly reports have
            something to bucket against.
          </p>
        ) : (
          <ul className="grid gap-3">
            {schoolYears.map((year) => (
              <li
                key={year.id}
                className={`relative flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-2xl p-4 shadow-sm ${
                  activeYear?.id === year.id
                    ? "bg-primary-container"
                    : "bg-surface-container"
                }`}
              >
                <div
                  className={`absolute inset-y-0 left-0 w-1.5 ${
                    activeYear?.id === year.id ? "bg-primary" : "bg-outline-variant"
                  }`}
                  aria-hidden
                />
                <div>
                  <p
                    className={`font-semibold ${
                      activeYear?.id === year.id ? "text-on-primary-container" : "text-on-surface"
                    }`}
                  >
                    {year.name}
                    {activeYear?.id === year.id && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-tertiary-container px-2.5 py-1 text-xs font-semibold text-on-tertiary-container">
                        Active
                      </span>
                    )}
                    {year.archived && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-semibold text-on-surface-variant">
                        Archived
                      </span>
                    )}
                  </p>
                  <p
                    className={`text-xs ${
                      activeYear?.id === year.id ? "text-on-primary-container" : "text-on-surface-variant"
                    }`}
                  >
                    {year.start_date} – {year.end_date}
                  </p>
                </div>
                {!year.archived && <ArchiveYearButton yearId={year.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
