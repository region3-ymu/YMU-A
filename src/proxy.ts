import type { NextRequest } from "next/server";
import { redirectWithCookies, updateSession } from "@/lib/supabase/proxy";
import { isAppRole, rolesAllowedForPath } from "@/lib/auth/roles";

// Reachable signed-out. /auth/* covers the email-confirm and signout route
// handlers; /~offline is the service-worker fallback page.
const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/reset-password",
  "/verify-email",
  "/auth",
  "/~offline",
];

// Signed-in users get bounced home from these (but not /update-password,
// which needs the recovery session, nor /auth/* handlers).
const AUTH_PAGES = ["/login", "/signup", "/reset-password", "/verify-email"];

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

// Optimistic checks only (per Next.js auth guide): session presence and the
// app_role JWT claim, no DB queries. Authoritative enforcement lives in the
// DAL (src/lib/auth/dal.ts) and in RLS.
export default async function proxy(request: NextRequest) {
  const { response, claims } = await updateSession(request);
  const pathname = request.nextUrl.pathname;
  const signedIn = claims !== null;

  if (!signedIn && !matchesPrefix(pathname, PUBLIC_PREFIXES)) {
    return redirectWithCookies(request, response, "/login");
  }

  if (signedIn && matchesPrefix(pathname, AUTH_PAGES)) {
    return redirectWithCookies(request, response, "/");
  }

  if (signedIn) {
    const allowed = rolesAllowedForPath(pathname);
    if (allowed) {
      const claimedRole = (
        claims.app_metadata as Record<string, unknown> | undefined
      )?.app_role;
      if (!isAppRole(claimedRole) || !allowed.includes(claimedRole)) {
        return redirectWithCookies(request, response, "/");
      }
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Skip static assets and PWA infrastructure (service worker, manifest,
    // icons); everything else goes through the auth checks above.
    "/((?!_next/static|_next/image|favicon\\.ico|serwist|icons|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
