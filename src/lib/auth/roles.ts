// Role model shared by the proxy (optimistic checks), the DAL (authoritative
// checks), and the UI (nav + labels). Mirrors the `app_role` / `region` enums
// from supabase/migrations/00000000000001_base_enums.sql.

export const APP_ROLES = [
  "teacher",
  "regional_manager",
  "academic_manager",
  "operations_manager",
  "cpo",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const REGIONS = ["central", "east", "west", "north", "south"] as const;

export type Region = (typeof REGIONS)[number];

// Deliberately NOT including academic_manager. MANAGER_ROLES gates /dashboard,
// /lists and /flags, and the RLS behind all three still enumerates
// regional_manager/operations_manager/cpo — an academic_manager admitted to
// those routes would load a page and see nothing, which is worse than not
// having the link. Widening those policies is its own piece of work; until
// then the role's surface is tickets, which is what YMU actually asked for.
export const MANAGER_ROLES = [
  "regional_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

// Roles whose ticket inbox is the whole organisation rather than one region.
// academic_manager exists for exactly this (YMU 2026-08-12): it reads every
// ticket but is only ever an *assignee* as the fallback for a region with no
// Regional Manager.
export const TICKET_GLOBAL_ROLES = [
  "academic_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

export function seesAllTickets(role: AppRole): boolean {
  return (TICKET_GLOBAL_ROLES as readonly AppRole[]).includes(role);
}

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
  academic_manager: "Academic Manager",
  operations_manager: "Operations Manager",
  cpo: "CPO",
};

/**
 * What to call someone on screen.
 *
 * `profiles.job_title` wins when it is set, because an organisation has more
 * job titles than it has permission levels — YMU's Academic Manager holds CPO
 * permissions (2026-08-12), and the only alternative was to make the
 * `academic_manager` role a synonym for `cpo`. That role is
 * `ticket_owner_for_school()`'s second tier, so doing it that way would have
 * silently re-routed every ticket from the 40 East and West schools that have
 * no Regional Manager.
 *
 * Display only. Nothing branches on the title; everything branches on `role`.
 */
export function displayRole(person: {
  role: AppRole;
  job_title?: string | null;
}): string {
  return person.job_title?.trim() || ROLE_LABELS[person.role];
}

export const REGION_LABELS: Record<Region, string> = {
  central: "Central",
  east: "East",
  west: "West",
  north: "North",
  south: "South",
};

// `icon` is a Material Symbols ligature name (see the Stitch design). Used by
// the Home menu grid and the bottom navigation bar.
export type NavItem = {
  href: string;
  label: string;
  note: string;
  icon: string;
  /** Rendered as a badge on the tile and the bottom bar. Omitted when zero. */
  badge?: number;
};

// operations_manager/cpo by role, OR profiles.is_app_admin regardless of role
// (currently only region3@ymu.org — see migration 0024) — the app_feedback
// inbox's actual authorization rule, mirrored here just for nav visibility.
export function canViewAppFeedback(role: AppRole, isAppAdmin: boolean): boolean {
  return role === "operations_manager" || role === "cpo" || isAppAdmin;
}

// PRD: teachers get Clocking; managers get Lists in its place. OM/CPO also
// get Team (role promotion). isAppAdmin additionally unlocks "App feedback"
// regardless of role (see canViewAppFeedback above).
export function navForRole(role: AppRole, isAppAdmin: boolean = false): NavItem[] {
  const items: NavItem[] = [];
  if (role === "teacher") {
    items.push({
      href: "/clocking",
      label: "Clocking",
      note: "Next class & clock-in",
      icon: "schedule",
    });
    items.push({
      href: "/feedback",
      label: "Feedbacks",
      note: "Pending & past submissions",
      icon: "rate_review",
    });
  } else if (role === "academic_manager") {
    // No Dashboard or Lists tile: those routes are still scoped to
    // MANAGER_ROLES at the query layer, so linking them would promise data the
    // database will not return.
  } else {
    items.push({
      href: "/dashboard",
      label: "Dashboard",
      note: "Today at a glance",
      icon: "dashboard",
    });
    items.push({
      href: "/lists",
      label: "Lists",
      note: "Schools & teachers",
      icon: "groups",
    });
  }
  items.push(
    {
      href: "/tickets",
      label: "Tickets",
      note: role === "teacher" ? "Support requests you raised" : "Support requests to resolve",
      icon: "confirmation_number",
    },
    {
      href: "/schedules",
      label: "Schedules",
      note: "Classes by school",
      icon: "calendar_month",
    },
    {
      href: "/reports",
      label: "Reports",
      note: "Hours & attendance",
      icon: "analytics",
    },
    {
      href: "/settings",
      label: "Settings",
      note: "Account, notifications & theme",
      icon: "settings",
    },
  );
  if (isManagerRole(role)) {
    items.push({
      href: "/flags",
      label: "Flags",
      note: "GPS & late clock-in escalations",
      icon: "flag",
    });
  }
  if (role === "operations_manager" || role === "cpo") {
    items.push({
      href: "/users",
      label: "Team",
      note: "Roles & regions",
      icon: "badge",
    });
  }
  if (canViewAppFeedback(role, isAppAdmin)) {
    items.push({
      href: "/app-feedback",
      label: "App feedback",
      note: "Bug reports from users",
      icon: "bug_report",
    });
  }
  return items;
}

// Home ("/") is the menu hub — a fixed entry that leads the bottom nav.
export const HOME_NAV_ITEM: NavItem = {
  href: "/",
  label: "Home",
  note: "Menu",
  icon: "home",
};

// Path prefixes with restricted roles, used for optimistic gating in
// src/proxy.ts and echoed authoritatively by requireRole() in each page.
export const ROUTE_ROLES: Record<string, readonly AppRole[]> = {
  "/clocking": ["teacher"],
  "/feedback": ["teacher"],
  // More specific than "/lists" below — must come first, since
  // rolesAllowedForPath() returns on the first matching prefix.
  "/lists/school-years": ["operations_manager", "cpo"],
  "/lists": MANAGER_ROLES,
  "/flags": MANAGER_ROLES,
  "/dashboard": MANAGER_ROLES,
  "/users": ["operations_manager", "cpo"],
  // Teachers reach their own tickets through /tickets too — the RLS policy is
  // what scopes them to their own rows, not the route.
  "/tickets": APP_ROLES,
};

export function rolesAllowedForPath(pathname: string): readonly AppRole[] | null {
  for (const [prefix, roles] of Object.entries(ROUTE_ROLES)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return roles;
    }
  }
  return null;
}
