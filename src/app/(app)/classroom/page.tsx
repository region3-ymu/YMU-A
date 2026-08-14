import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "YMU Classroom" };

// The one place the URL lives.
//
// It opens in a new tab rather than an <iframe>, and that is not a shortcut:
// ymuclassroom.net responds with `x-frame-options: SAMEORIGIN` (verified
// 2026-08-14 on both / and /home), so a browser refuses to render it inside
// another site no matter what we do here. It is an Acadle instance with its
// own sign-in, so an embed would ask for a second login anyway.
//
// If Acadle is ever configured to allow `frame-ancestors` for this app, this
// page becomes an <iframe src={YMU_CLASSROOM_URL} /> and nothing else changes.
export const YMU_CLASSROOM_URL = "https://ymuclassroom.net/";

export default async function ClassroomPage() {
  await requireRole("teacher");

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
          aria-hidden
        >
          <span className="material-symbols-outlined">school</span>
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">YMU Classroom</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Your courses, training and teaching resources.
          </p>
        </div>
      </header>

      <section className="rounded-2xl bg-surface-container p-5 shadow-sm">
        <p className="text-sm text-on-surface-variant">
          YMU Classroom opens in your browser and has its own sign-in. When you&apos;re
          done, come back here the same way you left.
        </p>
        <a
          href={YMU_CLASSROOM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 font-semibold text-on-primary shadow-sm transition-transform active:scale-[0.98]"
        >
          <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
          Open YMU Classroom
        </a>
      </section>
    </main>
  );
}
