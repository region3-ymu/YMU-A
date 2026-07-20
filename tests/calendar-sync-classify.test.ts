// Unit tests for classifyDiscoveredCalendar(), the pure decision function
// syncAllCalendars() uses to route a discovered calendar to auto-match,
// already-pinned, or the manager review queue. Pure and synchronous, so it's
// tested here against synthetic candidates with no Google/Supabase
// involved -- this is also where CALENDAR_MATCH_THRESHOLD/AMBIGUITY_MARGIN
// should be re-validated once the real planned calendar-summary strings are
// known, before enabling the sync against real calendars.

import { describe, expect, it } from "vitest";
import {
  classifyDiscoveredCalendar,
  type CalendarMatchCandidate,
} from "../supabase/functions/calendar-sync/sync.ts";

function candidate(school_id: string, school_name: string, score: number): CalendarMatchCandidate {
  return { school_id, school_name, score };
}

describe("classifyDiscoveredCalendar", () => {
  it("skips a calendar that is already pinned to a school", () => {
    const decision = classifyDiscoveredCalendar("cal-1", new Set(["cal-1"]), [candidate("s1", "School One", 0.9)]);
    expect(decision).toEqual({ action: "already_pinned" });
  });

  it("flags a calendar with zero candidates as unmatched", () => {
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), []);
    expect(decision).toEqual({ action: "flag_issue", reason: "no_matching_school", candidates: [] });
  });

  it("flags a calendar whose best candidate is below the threshold as unmatched", () => {
    const candidates = [candidate("s1", "School One", 0.2)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "flag_issue", reason: "no_matching_school", candidates });
  });

  it("flags an ambiguous match when the top two candidates are within the margin", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.7), candidate("s2", "Roosevelt Middle", 0.66)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "flag_issue", reason: "ambiguous_match", candidates });
  });

  it("auto-matches a clear top candidate above both the threshold and the ambiguity margin", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.9), candidate("s2", "Roosevelt Middle", 0.4)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.9 });
  });

  it("auto-matches a lone candidate with no second candidate to be ambiguous against", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.6)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates);
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.6 });
  });

  it("flags a calendar whose top school is already linked to a different calendar (two calendars sharing a name)", () => {
    // e.g. two real Google Calendars both literally named "South Dade Senior
    // High" -- the second one must never silently steal the first's pin.
    const candidates = [candidate("s1", "South Dade Senior High", 1)];
    const decision = classifyDiscoveredCalendar("cal-2", new Set(["cal-1"]), candidates, new Set(["s1"]));
    expect(decision).toEqual({ action: "flag_issue", reason: "school_already_linked", candidates });
  });

  it("still auto-matches when the top school is not in pinnedSchoolIds", () => {
    const candidates = [candidate("s1", "Roosevelt Elementary", 0.9)];
    const decision = classifyDiscoveredCalendar("cal-1", new Set(), candidates, new Set(["s2"]));
    expect(decision).toEqual({ action: "auto_match", schoolId: "s1", score: 0.9 });
  });
});
