import { cache } from "react";
import type { NavItem } from "@/lib/auth/roles";
import type { AppRole } from "@/lib/auth/roles";
import { getFeedbackOwed, getUnclockedClassCount } from "@/lib/attendance/queries";
import { isOverdue } from "@/lib/attendance/feedback-due";
import { getActionableTicketCount } from "@/lib/tickets/queries";
import { getUnreadNewsCount } from "@/lib/news/queries";

// The counts behind the little red numbers, in one place.
//
// The layout (bottom bar) and Home (menu tiles) both need them, and they used
// to disagree: the layout patched badges onto its own four-item slice while
// Home called navForRole() and never set `badge` at all — so NavItem.badge's
// own comment, "Rendered as a badge on the tile and the bottom bar", was only
// half true. A teacher with three feedbacks owed saw the 3 in the bar and
// nothing on the tile they were most likely to tap.
//
// react.cache dedupes within a render pass, so a teacher on "/" pays for
// getFeedbackOwed() once across the layout and the page rather than twice —
// same mechanism getProfile() uses in lib/auth/dal.ts.

export type NavBadges = {
  tickets: number;
  /** Owed feedback, overdue or not — the number a teacher needs to clear. */
  feedbackOwed: number;
  /** Of those, how many are past the 24-hour deadline. Drives the colour. */
  feedbackOverdue: number;
  /** Announcements this reader has not opened yet. */
  news: number;
  /**
   * What the home-screen app badge shows: everything actually waiting on this
   * person. Zero for anyone who is not a teacher — a manager's ticket queue is
   * work, not a personal to-do, and a permanent red dot on the icon would stop
   * meaning anything within a week.
   */
  appBadge: number;
};

export const getNavBadges = cache(async (role: AppRole): Promise<NavBadges> => {
  // Both reads are RLS-scoped, so a teacher counts their own owed feedback and
  // a Regional Manager counts their region's queue — no role branching needed
  // beyond skipping the query for roles that never owe feedback.
  const [tickets, owed, news, unclocked] = await Promise.all([
    getActionableTicketCount(),
    role === "teacher" ? getFeedbackOwed() : Promise.resolve([]),
    getUnreadNewsCount(),
    role === "teacher" ? getUnclockedClassCount() : Promise.resolve(0),
  ]);

  return {
    tickets,
    feedbackOwed: owed.length,
    feedbackOverdue: owed.filter((o) => isOverdue(o.feedback_due_at)).length,
    news,
    // A class started and not clocked into, plus feedback still owed. Both are
    // things only this teacher can clear, which is what a badge should mean.
    appBadge: role === "teacher" ? unclocked + owed.length : 0,
  };
});

/**
 * Attaches the counts to whichever nav items they belong to.
 *
 * Matched on exact href. Note `/feedback` (the teacher's own owed list) is a
 * different route from `/feedbacks` (the manager's reader) — deliberately not
 * a prefix match, so the singular/plural pair cannot cross-contaminate.
 */
export function applyNavBadges(items: NavItem[], badges: NavBadges): NavItem[] {
  return items.map((item) => {
    if (item.href === "/tickets") return { ...item, badge: badges.tickets };
    // Unread announcements are news, not a problem — never the red treatment.
    if (item.href === "/news") return { ...item, badge: badges.news, badgeUrgent: false };
    if (item.href === "/feedback") {
      return {
        ...item,
        badge: badges.feedbackOwed,
        badgeUrgent: badges.feedbackOverdue > 0,
      };
    }
    return item;
  });
}
