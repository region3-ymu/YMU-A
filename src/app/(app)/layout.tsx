import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { displayRole, HOME_NAV_ITEM, navForRole } from "@/lib/auth/roles";
import { getActionableTicketCount } from "@/lib/tickets/queries";
import { getFeedbackOwed } from "@/lib/attendance/queries";
import AppFeedbackButton from "@/components/app-feedback-button";
import BackButton from "@/components/back-button";
import BottomNav from "@/components/bottom-nav";
import GpsCheckSampler from "@/components/gps-check-sampler";
import OfflineIndicator from "@/components/offline-indicator";
import YmuMark from "@/components/ymu-mark";
import { signOut } from "../(auth)/actions";

// Shell for every signed-in page. data-role drives the per-role accent color
// (see globals.css); it lives here instead of <html> because this layout
// mounts fresh when navigation crosses from the (auth) group after login.
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const profile = await requireProfile();

  // Bottom nav = Home hub + the role's top destinations, capped so the bar
  // stays thumb-friendly on mobile. The full menu always lives on Home.
  // Badge counts. Both reads are RLS-scoped, so a teacher counts their own
  // owed feedback and a Regional Manager counts their region's queue — no role
  // branching needed here.
  const [ticketCount, owed] = await Promise.all([
    getActionableTicketCount(),
    profile.role === "teacher" ? getFeedbackOwed() : Promise.resolve([]),
  ]);

  const navItems = [HOME_NAV_ITEM, ...navForRole(profile.role, profile.is_app_admin).slice(0, 4)].map(
    (item) =>
      item.href === "/tickets"
        ? { ...item, badge: ticketCount }
        : item.href === "/feedback"
          ? { ...item, badge: owed.length }
          : item,
  );

  return (
    <div
      data-role={profile.role}
      className="flex flex-1 flex-col bg-background text-on-surface"
    >
      <header className="sticky top-0 z-40 border-b border-outline-variant/40 bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-2">
            <BackButton />
            <Link href="/" className="flex items-center gap-2" aria-label="Home">
              <YmuMark className="h-5 w-auto text-brand-mark" />
            </Link>
          </div>
          <div className="flex items-center gap-2.5">
            <OfflineIndicator />
            <span className="rounded-full bg-primary-container px-2.5 py-0.5 text-xs font-semibold text-on-primary-container">
              {displayRole(profile)}
            </span>
            <span className="hidden text-sm text-on-surface-variant sm:inline">
              {profile.full_name}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high"
                aria-label="Sign out"
                title="Sign out"
              >
                <span className="material-symbols-outlined text-xl" aria-hidden>
                  logout
                </span>
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Bottom padding clears the fixed BottomNav (h-16 + safe area). */}
      <div className="flex flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </div>

      <BottomNav items={navItems} />

      {/* Silent, renders nothing — only teachers have gps_checks rows at
          all (RLS-scoped), so this is a no-op for managers. Mounted here
          (not per-page) so sampling continues across in-app navigation. */}
      {profile.role === "teacher" && <GpsCheckSampler />}
      <AppFeedbackButton userId={profile.id} />
    </div>
  );
}
