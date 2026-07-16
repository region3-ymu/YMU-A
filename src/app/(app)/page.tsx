import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { navForRole } from "@/lib/auth/roles";

export default async function Home() {
  const profile = await requireProfile();
  const nav = navForRole(profile.role);

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Hi, {profile.full_name.split(" ")[0]}
        </h1>
        <p className="text-sm opacity-70">Young Musicians Unite — Attendance</p>
      </header>
      <ul className="grid grid-cols-2 gap-3">
        {nav.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="block rounded-2xl border border-foreground/10 p-4 transition-colors hover:border-accent"
            >
              <p className="font-semibold">{item.label}</p>
              <p className="text-xs opacity-60">{item.note}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
