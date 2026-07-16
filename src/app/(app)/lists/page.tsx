import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES } from "@/lib/auth/roles";
import Stub from "../stub";

export const metadata: Metadata = { title: "Lists" };

export default async function ListsPage() {
  await requireRole(...MANAGER_ROLES);
  return (
    <Stub title="Lists" note="Schools & teachers by region" phase={2} />
  );
}
