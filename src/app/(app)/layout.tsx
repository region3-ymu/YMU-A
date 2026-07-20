import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { ROLE_LABELS } from "@/lib/auth/roles";
import BackButton from "@/components/back-button";
import { signOut } from "../(auth)/actions";

// Shell for every signed-in page. data-role drives the per-role accent color
// (see globals.css); it lives here instead of <html> because this layout
// mounts fresh when navigation crosses from the (auth) group after login.
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const profile = await requireProfile();

  return (
    <div data-role={profile.role} className="flex flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-6 py-3">
        <div className="flex items-center gap-4">
          <BackButton />
          <Link href="/" className="font-bold tracking-tight">
            YMU-A
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">
            {ROLE_LABELS[profile.role]}
          </span>
          <span className="hidden text-sm opacity-70 sm:inline">
            {profile.full_name}
          </span>
          <form action={signOut}>
            <button type="submit" className="text-sm underline opacity-70">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
