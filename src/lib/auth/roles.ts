// Role model shared by the proxy (optimistic checks), the DAL (authoritative
// checks), and the UI (nav + labels). Mirrors the `app_role` / `region` enums
// from supabase/migrations/00000000000001_base_enums.sql.

export const APP_ROLES = [
  "teacher",
  "regional_manager",
  // Owns every afterschool class in every region, and nothing else (YMU
  // 2026-08-18). Not a regional_manager with region = null: the 48 uses of
  // current_app_region() would each have to tell "no region yet" apart from
  // "no region on purpose", and profiles.region is already nullable for the
  // first reason. Mirrors app_role in migration 0062.
  "afterschool_manager",
  "academic_manager",
  "operations_manager",
  // A peer of the CPO for administering accounts (YMU 2026-08-18). Replaces
  // reaching the app admin through profiles.is_app_admin, which is the
  // /app-feedback inbox flag (migration 0024) and was never meant to be a
  // permission level. Mirrors app_role in migration 0068.
  "administrator",
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
  // 0064 gave afterschool_manager a branch in flags_select,
  // attendance_sessions_select and calendar_events_select; 0070 did the same
  // for the definer functions that bypass RLS and re-check the region
  // themselves. So /dashboard, /flags, /lists, /reports and /substitutes all
  // have real rows to return for her. The one thing still region-only is
  // resolve_calendar_issue(), whose queue is hidden from her in
  // schedules-explorer.
  "afterschool_manager",
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

// Everyone who can read other people's class feedback at /feedbacks. This is
// NOT MANAGER_ROLES: feedback_submissions_select (0030) names academic_manager
// explicitly alongside operations_manager and cpo, and gives a
// regional_manager their own region — so unlike /dashboard and /lists, the
// page has real data to show all four. The exact same set, in the same order
// as the policy, so a reader can check one against the other.
export const FEEDBACK_READER_ROLES = [
  "regional_manager",
  "afterschool_manager",
  "academic_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

export function canReadTeamFeedback(role: AppRole): boolean {
  return (FEEDBACK_READER_ROLES as readonly AppRole[]).includes(role);
}

// Who can look for a substitute teacher. Mirrors the guard inside
// find_substitutes() in migration 0060 — SQL is authoritative, and it has to be:
// the function is SECURITY DEFINER and reads across every region, so this list
// existing here is only about what the nav offers.
//
// This is the Operations Manager's job. Until that role is filled, Regional
// Managers do it too, and they need every region's teachers — a substitute from
// the next region over beats no substitute (YMU 2026-08-14).
export const SUBSTITUTE_FINDER_ROLES = [
  "regional_manager",
  "afterschool_manager",
  "academic_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

export function canFindSubstitutes(role: AppRole): boolean {
  return (SUBSTITUTE_FINDER_ROLES as readonly AppRole[]).includes(role);
}

// Who can post an announcement on the News board. Everyone signed in reads it;
// only these four write, which is the "only admins can talk" shape YMU asked
// for. Mirrors can_publish_news() in migration 0053 — SQL is authoritative.
export const NEWS_AUTHOR_ROLES = [
  "regional_manager",
  "afterschool_manager",
  "academic_manager",
  "operations_manager",
  "administrator",
  "cpo",
] as const satisfies readonly AppRole[];

export function canPublishNews(role: AppRole): boolean {
  return (NEWS_AUTHOR_ROLES as readonly AppRole[]).includes(role);
}

/**
 * Who has an "own teachers" to aim an announcement at.
 *
 * Mirrors can_target_own_teachers() in migration 0071. Deliberately just these
 * two: a CPO's or an Operations Manager's own teachers are everybody, so
 * offering them the choice would be offering the same option twice.
 */
export const OWN_TEACHERS_AUDIENCE_ROLES = [
  "regional_manager",
  "afterschool_manager",
] as const satisfies readonly AppRole[];

export function canTargetOwnTeachers(role: AppRole): boolean {
  return (OWN_TEACHERS_AUDIENCE_ROLES as readonly AppRole[]).includes(role);
}

/** What "my teachers" means on screen, for the one role it differs for. */
export function ownTeachersLabel(role: AppRole, region: Region | null): string {
  if (role === "afterschool_manager") return "My afterschool teachers";
  return region ? `My teachers (${REGION_LABELS[region]})` : "My teachers";
}

// Who can create and edit other people's accounts at /users. Mirrors
// current_can_manage_team() in migration 0069 — SQL is authoritative, and it
// has to be: creating an auth user needs the service-role key, so the server
// action is the only place that check can live on the way in.
//
// Deliberately a role list and not a flag. 0067 briefly read
// profiles.is_app_admin here; YMU replaced that with the administrator role so
// the answer comes from the same column every other guard reads.
export const TEAM_ADMIN_ROLES = [
  "administrator",
  "academic_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

export function canManageTeam(role: AppRole, isAppAdmin: boolean = false): boolean {
  // isAppAdmin is a TEMPORARY BRIDGE, matching current_can_manage_team() in
  // migration 0069. region3@ymu.org is regional_manager + is_app_admin, and
  // administrator cannot read the app yet — 21 policies still enumerate
  // ('operations_manager','cpo'). Without this the page redirects the one
  // person maintaining it straight back to Home. Removed together with the SQL
  // branch once administrator is a real peer of cpo.
  return (TEAM_ADMIN_ROLES as readonly AppRole[]).includes(role) || isAppAdmin;
}

/** Peers of the CPO for handing out Operations Manager. Mirrors 0069. */
export function canAssignOperationsManager(role: AppRole): boolean {
  return role === "cpo" || role === "administrator";
}

/**
 * The roles a team admin may hand out when creating or editing an account.
 *
 * The CPO role is never in here — 0003 seeds it by hand and promote_user()
 * raises on it. Operations Manager is CPO/administrator only, which is the one
 * rule that differs between the four admin roles.
 */
export function assignableRoles(callerRole: AppRole): AppRole[] {
  const base: AppRole[] = [
    "teacher",
    "regional_manager",
    "afterschool_manager",
    "academic_manager",
    "administrator",
  ];
  return canAssignOperationsManager(callerRole) ? [...base, "operations_manager"] : base;
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

// MANAGER_ROLES minus the afterschool manager. resolve_calendar_issue() maps a
// whole Google calendar onto a school — school-level work, still
// (regional_manager, operations_manager, cpo) in SQL — so /lists/calendar-sync
// has to refuse her rather than merely hide its link. Kept as a constant so the
// route guard and the SQL guard can be read against each other.
export const CALENDAR_SYNC_ROLES = [
  "regional_manager",
  "operations_manager",
  "cpo",
] as const satisfies readonly AppRole[];

export function isManagerRole(role: AppRole): boolean {
  return (MANAGER_ROLES as readonly AppRole[]).includes(role);
}

export const ROLE_LABELS: Record<AppRole, string> = {
  teacher: "Teacher",
  regional_manager: "Regional Manager",
  afterschool_manager: "Afterschool Manager",
  academic_manager: "Academic Manager",
  administrator: "Administrator",
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
  /**
   * Makes the badge read as a problem rather than a queue — currently "some of
   * these are past their deadline". Set by applyNavBadges (lib/nav/badges.ts).
   */
  badgeUrgent?: boolean;
};

// operations_manager/cpo by role, OR profiles.is_app_admin regardless of role
// (currently only region3@ymu.org — see migration 0024) — the app_feedback
// inbox's actual authorization rule, mirrored here just for nav visibility.
export function canViewAppFeedback(role: AppRole, isAppAdmin: boolean): boolean {
  return role === "operations_manager" || role === "cpo" || isAppAdmin;
}

// ORDER IS THE INTERFACE, not a detail.
//
// The (app) layout puts Home plus only the FIRST FOUR of these in the bottom
// bar; everything after that is reachable from the Home grid alone. So the
// order below decides what a role can reach in one tap all day.
//
// Managers asked for Home · Dashboard · Flags · Tickets · Schedules
// (YMU 2026-08-14), which is why Flags moved from the end of the list to
// second, and Lists and Feedbacks moved behind Schedules — both are things
// you go looking for, not things you check between classes.
export function navForRole(role: AppRole, isAppAdmin: boolean = false): NavItem[] {
  const items: NavItem[] = [];

  if (role === "teacher") {
    items.push(
      { href: "/clocking", label: "Clocking", note: "Next class & clock-in", icon: "schedule" },
      { href: "/feedback", label: "Feedbacks", note: "Pending & past submissions", icon: "rate_review" },
      {
        href: "/tickets",
        label: "Tickets",
        note: "Support requests you raised",
        icon: "confirmation_number",
      },
      { href: "/schedules", label: "Schedules", note: "Classes by school", icon: "calendar_month" },
      // Fifth onwards land on the Home grid rather than the bottom bar —
      // places you go deliberately, not between classes.
      { href: "/news", label: "News", note: "Announcements & resources", icon: "campaign" },
      {
        href: "/classroom",
        label: "YMU Classroom",
        note: "Courses & training",
        icon: "school",
      },
    );
  } else {
    // Dashboard and Flags are still scoped to MANAGER_ROLES at the query layer,
    // and academic_manager is not in it — linking them for that role would
    // promise data the database will not return. Feedbacks below is different:
    // feedback_submissions_select names academic_manager explicitly.
    if (isManagerRole(role)) {
      items.push(
        { href: "/dashboard", label: "Dashboard", note: "Today at a glance", icon: "dashboard" },
        { href: "/flags", label: "Flags", note: "GPS & late clock-in escalations", icon: "flag" },
      );
    }
    items.push(
      {
        href: "/tickets",
        label: "Tickets",
        note: "Support requests to resolve",
        icon: "confirmation_number",
      },
      { href: "/schedules", label: "Schedules", note: "Classes by school", icon: "calendar_month" },
    );
    if (isManagerRole(role)) {
      items.push({ href: "/lists", label: "Lists", note: "Schools & teachers", icon: "groups" });
    }
    if (canFindSubstitutes(role)) {
      // Deliberately after the first four: covering an absence is something you
      // go looking for, not something you check between classes.
      items.push({
        href: "/substitutes",
        label: "Substitutes",
        note: "Cover a class when a teacher is out",
        icon: "person_search",
      });
    }
    if (canReadTeamFeedback(role)) {
      items.push({
        href: "/feedbacks",
        label: "Feedbacks",
        note:
          role === "regional_manager"
            ? "What your teachers reported"
            : role === "afterschool_manager"
              ? "What your afterschool teachers reported"
              : "What teachers reported",
        icon: "rate_review",
      });
    }
    items.push({
      href: "/news",
      label: "News",
      note: canPublishNews(role) ? "Post announcements" : "Announcements & resources",
      icon: "campaign",
    });
  }

  items.push(
    { href: "/reports", label: "Reports", note: "Hours & attendance", icon: "analytics" },
    {
      href: "/settings",
      label: "Settings",
      note: "Account, notifications & theme",
      icon: "settings",
    },
  );
  if (canManageTeam(role, isAppAdmin)) {
    items.push({
      href: "/users",
      label: "Team",
      note: "Add people, roles & regions",
      icon: "badge",
    });
  }
  if (role === "operations_manager" || role === "cpo" || role === "administrator") {
    // Sits on the Home grid, not the bottom bar: it is for showing the app to
    // other people, which is a thing you plan, not a thing you do between
    // classes.
    items.push({
      href: "/demo",
      label: "Demo",
      note: "Walk someone through the app",
      icon: "play_circle",
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
  // Before "/feedback" for the same reason "/lists/school-years" comes before
  // "/lists": first matching prefix wins. The two do not actually collide
  // (startsWith("/feedback/") is false for "/feedbacks"), but the pair is one
  // renamed route away from doing so, and the failure would be silent.
  "/feedbacks": FEEDBACK_READER_ROLES,
  "/feedback": ["teacher"],
  "/classroom": ["teacher"],
  "/demo": ["operations_manager", "cpo"],
  // More specific than "/lists" below — must come first, since
  // rolesAllowedForPath() returns on the first matching prefix.
  "/lists/school-years": ["operations_manager", "cpo"],
  "/lists": MANAGER_ROLES,
  "/flags": MANAGER_ROLES,
  "/dashboard": MANAGER_ROLES,
  "/users": ["operations_manager", "cpo"],
  "/substitutes": SUBSTITUTE_FINDER_ROLES,
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
