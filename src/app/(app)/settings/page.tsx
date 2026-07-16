import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import Stub from "../stub";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireProfile();
  return (
    <Stub title="Settings" note="Notifications & theme" phase={7} />
  );
}
