export type CalendarSyncResult = {
  calendarId: string;
  schoolId: string;
  result?: { mode: string; processed: number; reconciledRemovals: number; queuedNotifications: number };
  error?: string;
};

export type CalendarSyncSummary =
  | { skipped: true }
  | {
      skipped: false;
      discovered: number;
      autoMatched: number;
      issuesRaised: number;
      partial: boolean;
      synced: CalendarSyncResult[];
    };
