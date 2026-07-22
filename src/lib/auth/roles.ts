// Role model shared by the proxy (optimistic checks), the DAL (authoritative
// checks), and the UI (nav + labels). Mirrors the `app_role` / `region` enums
// from supabase/migrations/00000000000001_base_enums.sql.

export const APP_ROLES = [
  "teacher",
  "regional_manager",
  "operations_manager",
  "cpo",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const REGIONS = ["central", "east", "west", "north", "south"] as const;

export type Region = (typeof REGIONS)[number];

export const MANAGER_ROLES = [
  "regional_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

export function isAppRole(value: unknown): value is AppRole {
  return (
    typeof value === "string" && (APP_ROLES as readonly string[]).includes(value)
  );
}

export function isRegion(value: unknown): value is Region {
  return (
    typeof value === "string" && (REGIONS as readonly string[]).includes(value)
  );
}

export function isManagerRole(role: AppRole): boolean {
  return (MANAGER_ROLES as readonly AppRole[]).includes(role);
}

export const ROLE_LABELS: Record<AppRole, string> = {
  teacher: "Teacher",
  regional_manager: "Regional Manager",
  operations_manager: "Operations Manager",
  cpo: "CPO",
};

export const REGION_LABELS: Record<Region, string> = {
  central: "Central",
  east: "East",
  west: "West",
  north: "North",
  south: "South",
};

export type NavItem = { href: string; label: string; note: string };

// PRD: teachers get Clocking; managers get Lists in its place. OM/CPO also
// get Team (role promotion).
export function navForRole(role: AppRole): NavItem[] {
  const items: NavItem[] = [];
  if (role === "teacher") {
    items.push({
      href: "/clocking",
      label: "Clocking",
      note: "Next class & clock-in",
    });
  } else {
    items.push({
      href: "/dashboard",
      label: "Dashboard",
      note: "Today at a glance",
    });
    items.push({
      href: "/lists",
      label: "Lists",
      note: "Schools & teachers",
    });
  }
  items.push(
    { href: "/schedules", label: "Schedules", note: "Classes by school" },
    { href: "/reports", label: "Reports", note: "Hours & attendance" },
    { href: "/settings", label: "Settings", note: "Notifications & theme" },
  );
  if (isManagerRole(role)) {
    items.push({
      href: "/flags",
      label: "Flags",
      note: "GPS & late clock-in escalations",
    });
  }
  if (role === "operations_manager" || role === "cpo") {
    items.push({
      href: "/users",
      label: "Team",
      note: "Roles & regions",
    });
  }
  return items;
}

// Path prefixes with restricted roles, used for optimistic gating in
// src/proxy.ts and echoed authoritatively by requireRole() in each page.
export const ROUTE_ROLES: Record<string, readonly AppRole[]> = {
  "/clocking": ["teacher"],
  "/feedback": ["teacher"],
  "/lists": MANAGER_ROLES,
  "/flags": MANAGER_ROLES,
  "/dashboard": MANAGER_ROLES,
  "/users": ["operations_manager", "cpo"],
};

export function rolesAllowedForPath(pathname: string): readonly AppRole[] | null {
  for (const [prefix, roles] of Object.entries(ROUTE_ROLES)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return roles;
    }
  }
  return null;
}
