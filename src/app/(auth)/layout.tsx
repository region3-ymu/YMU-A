export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">YMU-A</h1>
          <p className="text-sm opacity-70">Young Musicians Unite — Attendance</p>
        </header>
        <div className="rounded-2xl border border-foreground/10 p-6">
          {children}
        </div>
      </div>
    </main>
  );
}
