"use server";

import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { SUBSTITUTE_FINDER_ROLES } from "@/lib/auth/roles";
import type { Candidate, FindResult } from "./types";

/**
 * Who could cover the given class.
 *
 * The ranking lives in find_substitutes() (migration 0060), not here — it has to,
 * because a Regional Manager's RLS scope stops at their own region and a useful
 * search reaches past it. The function is SECURITY DEFINER and re-checks the
 * caller's role itself; requireRole below is the outer layer, not the only one.
 */
export async function findSubstitutes(eventId: string): Promise<FindResult> {
  await requireRole(...SUBSTITUTE_FINDER_ROLES);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_substitutes", { p_event_id: eventId });

  if (error) return { ok: false, error: error.message };

  return { ok: true, candidates: (data ?? []) as Candidate[] };
}
