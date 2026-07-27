import { getZohoFeedbackConfig, type ZohoFeedbackConfig } from "@/lib/attendance/zoho-feedback";

// Constants for this week's PD "relay" feedback form (native in-app,
// close_session_with_relay_feedback / migration 0022) — exact choice text
// copied from the real reference Google Form ("YMU Teacher Relays – Teacher
// Self-Reflection Form"), read directly out of its FB_PUBLIC_LOAD_DATA_
// payload rather than guessed, so a submitted value always matches what the
// reference form itself would have recorded. "Teacher Name" and "Day of
// Session" are intentionally not asked here — the app already knows both.

export const RELAY_BLOCKS = ["Block 1", "Block 2", "Block 3", "Block 4"] as const;

export const PROGRAM_AREAS = ["Modern Band", "Drumline", "Beginning Band / Winds", "Music Production"] as const;

export const ACHIEVED_OBJECTIVE_OPTIONS = [
  "Yes - Fully achieved",
  "Partially - Achieved with minor adjustments",
  "No - Did not achieve",
] as const;

// 1-5 linear scale; labels are the reference form's own low/high anchors.
export const ENGAGEMENT_SCALE_MIN_LABEL = "Low Engagement / Passive";
export const ENGAGEMENT_SCALE_MAX_LABEL = "High Engagement / Active All-Play";
export const ENGAGEMENT_SCALE_VALUES = [1, 2, 3, 4, 5] as const;

export const CHALLENGE_OPTIONS = [
  "Classroom Management / Student Focus",
  "Pacing & Time Management (20-min limit)",
  "Technical / Equipment / Setup Issues",
  "Pedagogical / Musical Execution",
  "None / Everything went smoothly",
] as const;

export type RelayFeedbackInput = {
  relayBlock: string;
  programArea: string;
  objective: string;
  achievedObjective: string;
  objectiveReflection: string;
  engagementScale: number;
  challenges: string[];
  pivots: string;
};

// Which provider is currently wired into /feedback and /clocking. Defaults
// to "zoho" (unchanged behavior) — set FEEDBACK_FORM_PROVIDER=relay for this
// week's PD sessions. Switching back after the week is a one-line env var
// change, no code change, no migration to undo (both paths' columns and
// RPCs coexist independently).
export type FeedbackFormProvider = "zoho" | "relay";

export function getFeedbackFormProvider(): FeedbackFormProvider {
  return process.env.FEEDBACK_FORM_PROVIDER === "relay" ? "relay" : "zoho";
}

export type FeedbackFormConfig = { provider: "zoho"; config: ZohoFeedbackConfig } | { provider: "relay" } | null;

// Single entry point for both /feedback and /clocking: picks the provider
// from FEEDBACK_FORM_PROVIDER and returns its config already tagged, so the
// page components don't each duplicate the provider-switch logic. The
// "relay" provider needs no config — it's a native form, nothing to look up.
export function getFeedbackConfig(): FeedbackFormConfig {
  if (getFeedbackFormProvider() === "relay") {
    return { provider: "relay" };
  }
  const config = getZohoFeedbackConfig();
  return config ? { provider: "zoho", config } : null;
}
