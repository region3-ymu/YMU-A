import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import Stub from "../stub";

export const metadata: Metadata = { title: "Schedules" };

export default async function SchedulesPage() {
  await requireProfile();
  return (
    <Stub title="Schedules" note="Classes by school" phase={3} />
  );
}
