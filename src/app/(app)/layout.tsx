import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { ROLE_LABELS } from "@/lib/auth/roles";
import BackButton from "@/components/back-button";
import GpsCheckSampler from "@/components/gps-check-sampler";
import OfflineIndicator from "@/components/offline-indicator";
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
          <OfflineIndicator />
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
      {/* Silent, renders nothing — only teachers have gps_checks rows at
          all (RLS-scoped), so this is a no-op for managers. Mounted here
          (not per-page) so sampling continues across in-app navigation. */}
      {profile.role === "teacher" && <GpsCheckSampler />}
    </div>
  );
}
