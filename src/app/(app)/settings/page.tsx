import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import DarkModeToggle from "./dark-mode-toggle";
import PushSettings from "./push-settings";
import NotificationSettings from "./notification-settings";
import ChangePassword from "./change-password";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const profile = await requireProfile();

  const supabase = await createClient();
  const { data: prefs } = await supabase
    .from("notification_preferences")
    .select("type, enabled, lead_minutes")
    .eq("user_id", profile.id);

  return (
    <main className="flex flex-1 flex-col p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
        <span className="material-symbols-outlined" aria-hidden>settings</span>
        Settings
      </h1>
      <p className="mt-1 text-sm text-on-surface-variant">Account, notifications & theme</p>

      <div className="mt-6">
        <DarkModeToggle />
      </div>

      <div className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Push notifications</h2>
        <div className="mt-3">
          <PushSettings />
        </div>
      </div>

      <NotificationSettings userId={profile.id} initialPrefs={prefs ?? []} />

      {/* Last, because it is the least-used control here — but it is the ONLY
          way to change a password while "Forgot password?" cannot deliver
          mail. profile.email comes from auth.users via the DAL and is what the
          re-verification signs in with. */}
      {profile.email && (
        <div className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Password</h2>
          <div className="mt-3">
            <ChangePassword email={profile.email} />
          </div>
        </div>
      )}
    </main>
  );
}
