import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth/dal";
import Stub from "../stub";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requireProfile();
  return (
    <Stub title="Reports" note="Hours & attendance" phase={8} />
  );
}
