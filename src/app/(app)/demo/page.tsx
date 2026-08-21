import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import StartDemoButton from "./start-demo-button";

export const metadata: Metadata = { title: "Demo" };

// The demo teacher's login. The password is set out of band and deliberately
// not in this repo — see the note in the card below.
const DEMO_TEACHER_EMAIL = "teacher@ymu.org";

export default async function DemoPage() {
  await requireRole("operations_manager", "cpo");

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
          aria-hidden
        >
          <span className="material-symbols-outlined">play_circle</span>
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">Demo</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Show the whole workflow, from a manager&apos;s side and a teacher&apos;s.
          </p>
        </div>
      </header>

      <section className="rounded-2xl bg-surface-container p-5 shadow-sm">
        <p className="text-sm text-on-surface-variant">
          This gives <span className="font-semibold text-on-surface">Demo Teacher</span> a
          class that is happening right now, so you can clock in, send
          class feedback and raise a ticket in front of an audience. Nothing here touches
          real attendance: the demo site is excluded from Reports and the dashboard, and it
          belongs to no region.
        </p>
        <div className="mt-4">
          <StartDemoButton teacherEmail={DEMO_TEACHER_EMAIL} />
        </div>
      </section>
    </main>
  );
}
