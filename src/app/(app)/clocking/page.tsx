import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import Stub from "../stub";

export const metadata: Metadata = { title: "Clocking" };

export default async function ClockingPage() {
  await requireRole("teacher");
  return (
    <Stub title="Clocking" note="Next class & clock-in" phase={4} />
  );
}
