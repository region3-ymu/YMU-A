// Data access layer for auth (server-side only). Pages and server actions
// call these instead of checking sessions ad hoc; the proxy only does
// optimistic JWT checks, this is the authoritative layer.

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AppRole, Region } from "@/lib/auth/roles";

export type Profile = {
  id: string;
  email: string | undefined;
  full_name: string;
  phone: string | null;
  role: AppRole;
  region: Region | null;
  subjects: string[];
  emergency_contact: string | null;
  archived_at: string | null;
};

// Memoized per request/render pass. Returns null when signed out. Archived
// accounts are bounced to /auth/signout (a route handler, because cookie
// writes are not allowed during server-component render) which clears the
// session — this is the archived-account gate: no authed page ever renders
// for them, so they cannot clock in or see schedules.
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id, full_name, phone, role, region, subjects, emergency_contact, archived_at",
    )
    .eq("id", user.id)
    .single();
  if (!profile) return null;

  if (profile.archived_at) {
    redirect("/auth/signout?error=archived");
  }

  return { ...profile, email: user.email };
});

export async function requireProfile(): Promise<Profile> {
  const profile = await getProfile();
  // By the time we get here, the proxy's optimistic JWT check already let
  // this request through as "signed in" (an outright signed-out visitor
  // never reaches this far — the proxy redirects those to /login itself).
  // So a null profile here means the proxy's locally-decoded claims and this
  // authoritative getUser() call disagree: the access token still looks
  // unexpired, but the session was actually revoked server-side (a password
  // change, an admin deleting/archiving the user, etc — reproduced live via
  // re-running the account-seeding script against an already-signed-in
  // device). Routing to /login directly would leave the stale cookie in
  // place, and the proxy would keep reading it as "signed in" on every
  // subsequent request — bouncing /login back to / and / back to /login
  // forever (a real "too many redirects" browser error, not hypothetical).
  // /auth/signout actually clears the session cookie (a route handler can
  // write cookies; a Server Component mid-render cannot), which is what
  // breaks the loop — same reason the archived-account case above already
  // routes through it instead of a bare redirect.
  if (!profile) redirect("/auth/signout");
  return profile;
}

export async function requireRole(...roles: AppRole[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) redirect("/");
  return profile;
}
