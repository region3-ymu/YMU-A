"use client";

import Dexie, { type EntityTable } from "dexie";
import type { FeedbackDraft } from "./zoho-feedback";

// Local-only storage for a feedback draft answered while offline (the Zoho
// form itself needs connectivity to load/submit — see DECISIONS.md, "Offline
// feedback"). One row per attendance session; cleared once the session
// actually closes (webhook confirmed) or the teacher discards the draft.
type DraftRow = FeedbackDraft & { sessionId: string; savedAt: string };

const db = new Dexie("ymu-a-feedback-drafts") as Dexie & {
  drafts: EntityTable<DraftRow, "sessionId">;
};
db.version(1).stores({ drafts: "sessionId" });

export async function saveFeedbackDraft(sessionId: string, draft: FeedbackDraft): Promise<void> {
  await db.drafts.put({ ...draft, sessionId, savedAt: new Date().toISOString() });
}

export async function getFeedbackDraft(sessionId: string): Promise<FeedbackDraft | null> {
  const row = await db.drafts.get(sessionId);
  if (!row) return null;
  return { rating: row.rating, summary: row.summary, challenges: row.challenges, studentsPresent: row.studentsPresent };
}

export async function clearFeedbackDraft(sessionId: string): Promise<void> {
  await db.drafts.delete(sessionId);
}
