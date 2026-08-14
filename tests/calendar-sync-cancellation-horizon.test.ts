// Unit tests for cancellationIsWorthNotifying(), the guard that keeps bulk
// calendar housekeeping from fanning out a push per teacher per deleted
// instance. Pure and synchronous, so the horizon's boundaries are pinned here
// rather than discovered in production a year from now.

import { describe, expect, it } from "vitest";
import { cancellationIsWorthNotifying } from "../supabase/functions/calendar-sync/sync.ts";

const NOW = new Date("2026-08-14T18:00:00.000Z");

function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

describe("cancellationIsWorthNotifying", () => {
  it("notifies about a class later today", () => {
    expect(cancellationIsWorthNotifying("2026-08-14T21:00:00.000Z", NOW)).toBe(true);
  });

  it("notifies about a class six days out", () => {
    expect(cancellationIsWorthNotifying(inDays(6), NOW)).toBe(true);
  });

  it("notifies right up to the horizon", () => {
    expect(cancellationIsWorthNotifying(inDays(7), NOW)).toBe(true);
  });

  it("stays quiet just past the horizon", () => {
    expect(cancellationIsWorthNotifying(inDays(7.001), NOW)).toBe(false);
  });

  it("stays quiet about next year's recurrence series", () => {
    // The real payload that motivated this guard: a 2027-06-03 instance
    // cancelled during a bulk cleanup in August 2026.
    expect(cancellationIsWorthNotifying("2027-06-03T17:00:00.000Z", NOW)).toBe(false);
  });

  it("stays quiet about a class that already started", () => {
    expect(cancellationIsWorthNotifying("2026-08-14T17:59:00.000Z", NOW)).toBe(false);
  });

  it("treats a class starting exactly now as past", () => {
    expect(cancellationIsWorthNotifying(NOW.toISOString(), NOW)).toBe(false);
  });

  it("stays quiet when the event has no start time at all", () => {
    expect(cancellationIsWorthNotifying(null, NOW)).toBe(false);
  });

  it("stays quiet on an unparseable start time rather than throwing", () => {
    expect(cancellationIsWorthNotifying("not a date", NOW)).toBe(false);
  });

  it("honours a caller-supplied horizon", () => {
    expect(cancellationIsWorthNotifying(inDays(10), NOW, 14)).toBe(true);
    expect(cancellationIsWorthNotifying(inDays(10), NOW, 7)).toBe(false);
  });
});
