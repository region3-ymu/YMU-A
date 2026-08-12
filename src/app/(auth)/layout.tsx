import YmuMark from "@/components/ymu-mark";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-surface p-6">
      {/* Decorative background blobs (Stitch login). Purely ornamental. */}
      <div className="pointer-events-none absolute inset-0 -z-0" aria-hidden>
        <div className="absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-primary-fixed opacity-40 blur-3xl" />
        <div className="absolute -right-16 bottom-8 h-72 w-72 rounded-full bg-tertiary-fixed opacity-30 blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-sm">
        <div className="rounded-3xl bg-surface-container-lowest p-6 shadow-xl">
          <div className="mb-6 flex flex-col items-center text-center">
            {/* The real mark replaces the placeholder music-note badge. The
                heading that used to read "YMU-A" is gone with it — the logo
                already says who this is, and repeating it in text underneath
                is the kind of thing nobody removes later. */}
            <YmuMark className="mb-4 h-11 w-auto text-brand-mark" />
            <h1 className="text-lg font-semibold tracking-tight text-on-surface">
              Attendance
            </h1>
            <p className="mt-0.5 text-sm text-on-surface-variant">
              Young Musicians Unite
            </p>
          </div>
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-on-surface-variant opacity-70">
          Secured sign-in
        </p>
      </div>
    </main>
  );
}
