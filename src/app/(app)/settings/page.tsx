import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import DarkModeToggle from "./dark-mode-toggle";
import PushSettings from "./push-settings";
import NotificationSettings from "./notification-settings";

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
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm opacity-70">Notifications & theme</p>

      <div className="mt-6">
        <DarkModeToggle />
      </div>

      <div className="mt-6">
        <h2 className="text-lg font-bold">Push notifications</h2>
        <div className="mt-3">
          <PushSettings />
        </div>
      </div>

      <NotificationSettings userId={profile.id} initialPrefs={prefs ?? []} />
    </main>
  );
}
