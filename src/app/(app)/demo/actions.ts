"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

export type DemoState =
  | { error: string }
  | { ready: true; startedAt: string; endsAt: string }
  | undefined;

/**
 * Hands the demo teacher a class that is in progress right now.
 *
 * All the work is in start_demo_shift() — one transaction, so a demo can never
 * half-exist. start_demo_shift() re-checks the role in SQL; requireRole here is
 * the courtesy that keeps the button off other people's screens.
 */
export async function startDemoShift(
  _previous: DemoState,
  _formData: FormData,
): Promise<DemoState> {
  await requireRole("operations_manager", "cpo");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_demo_shift");
  if (error) return { error: error.message };

  const result = (data ?? {}) as { start_at?: string; end_at?: string };

  // The demo teacher's own screens are the point of this, and they are rendered
  // for a different session — but the CPO's Schedules and Dashboard show the
  // demo class too, so refresh what this caller can see.
  revalidatePath("/demo");
  revalidatePath("/schedules");
  revalidatePath("/dashboard");

  return {
    ready: true,
    startedAt: result.start_at ?? new Date().toISOString(),
    endsAt: result.end_at ?? new Date().toISOString(),
  };
}
