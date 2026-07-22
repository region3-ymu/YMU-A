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
        <Link href="/lists" className="text-sm underline opacity-70">
          ← Lists
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">School years</h1>
        <p className="mt-1 text-sm opacity-70">
          Attendance/schedules link to a school year by date — no year is ever
          picked manually. Archiving a completed year only hides it from
          &ldquo;active&rdquo; status here; its reports keep generating from the
          same date range.
        </p>
      </header>

      <CreateSchoolYearForm />

      <section>
        <h2 className="mb-2 text-lg font-semibold">All school years</h2>
        {schoolYears.length === 0 ? (
          <p className="text-sm opacity-60">
            No school years yet — create one above so quarterly reports have
            something to bucket against.
          </p>
        ) : (
          <ul className="grid gap-2">
            {schoolYears.map((year) => (
              <li
                key={year.id}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 ${
                  activeYear?.id === year.id
                    ? "border-accent/50 bg-accent/5"
                    : "border-foreground/10"
                }`}
              >
                <div>
                  <p className="font-semibold">
                    {year.name}
                    {activeYear?.id === year.id && (
                      <span className="ml-2 rounded-full bg-accent/20 px-2 py-0.5 text-xs font-normal">
                        Active
                      </span>
                    )}
                    {year.archived && (
                      <span className="ml-2 rounded-full border border-foreground/20 px-2 py-0.5 text-xs font-normal opacity-60">
                        Archived
                      </span>
                    )}
                  </p>
                  <p className="text-xs opacity-60">
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
