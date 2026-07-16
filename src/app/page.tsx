const tabs = [
  { label: "Clocking", note: "Next class & clock-in" },
  { label: "Schedules", note: "Your classes by school" },
  { label: "Reports", note: "Hours & attendance" },
  { label: "Settings", note: "Notifications & theme" },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">YMU-A</h1>
        <p className="text-sm opacity-70">
          Young Musicians Unite — Attendance
        </p>
      </header>
      <ul className="grid grid-cols-2 gap-3">
        {tabs.map((tab) => (
          <li
            key={tab.label}
            className="rounded-2xl border border-foreground/10 p-4"
          >
            <p className="font-semibold">{tab.label}</p>
            <p className="text-xs opacity-60">{tab.note}</p>
          </li>
        ))}
      </ul>
      <p className="mt-auto pt-8 text-center text-xs opacity-50">
        Phase 0 shell — sign-in arrives in Phase 1.
      </p>
    </main>
  );
}
