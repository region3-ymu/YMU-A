"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ResponsibilityCheckDialog from "./responsibility-check-dialog";

type PreferenceType = "be_there_soon" | "clock_in_reminder" | "clock_out_reminder" | "schedule_changed" | "class_cancelled";

// Mirrored from supabase/migrations/0014_notifications.sql's
// enqueue_reminder_notifications() coalesce() defaults — keep in sync.
const TYPE_META: { type: PreferenceType; label: string; note: string; hasLead: boolean; defaultLead: number }[] = [
  {
    type: "be_there_soon",
    label: "Be-there-soon reminder",
    note: "Before class starts, so you have time to travel there.",
    hasLead: true,
    defaultLead: 15,
  },
  {
    type: "clock_in_reminder",
    label: "Clock-in reminder",
    note: "Around class start, if you haven't clocked in yet.",
    hasLead: true,
    defaultLead: 0,
  },
  {
    type: "clock_out_reminder",
    label: "Clock-out reminder",
    note: "Around class end, if you're still clocked in. Also backed up by email.",
    hasLead: true,
    defaultLead: 0,
  },
  {
    type: "schedule_changed",
    label: "Schedule changed",
    note: "Time, location, or teacher assignment changed. Also backed up by email.",
    hasLead: false,
    defaultLead: 0,
  },
  {
    type: "class_cancelled",
    label: "Class cancelled",
    note: "A scheduled class was cancelled. Also backed up by email.",
    hasLead: false,
    defaultLead: 0,
  },
];

export type PreferenceRow = { type: string; enabled: boolean; lead_minutes: number | null };

export default function NotificationSettings({
  userId,
  initialPrefs,
}: {
  userId: string;
  initialPrefs: PreferenceRow[];
}) {
  const [state, setState] = useState<Record<PreferenceType, { enabled: boolean; leadMinutes: number }>>(() => {
    const byType = new Map(initialPrefs.map((p) => [p.type, p]));
    const initial = {} as Record<PreferenceType, { enabled: boolean; leadMinutes: number }>;
    for (const meta of TYPE_META) {
      const row = byType.get(meta.type);
      initial[meta.type] = {
        enabled: row?.enabled ?? true,
        leadMinutes: row?.lead_minutes ?? meta.defaultLead,
      };
    }
    return initial;
  });
  const [pendingDisable, setPendingDisable] = useState<PreferenceType | null>(null);
  const [savingType, setSavingType] = useState<PreferenceType | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function persist(type: PreferenceType, patch: Partial<{ enabled: boolean; lead_minutes: number }>) {
    setSavingType(type);
    setError(null);
    const supabase = createClient();
    const { error: upsertError } = await supabase
      .from("notification_preferences")
      .upsert({ user_id: userId, type, ...patch }, { onConflict: "user_id,type" });
    setSavingType(null);
    if (upsertError) setError(upsertError.message);
  }

  function setEnabled(type: PreferenceType, enabled: boolean) {
    setState((prev) => ({ ...prev, [type]: { ...prev[type], enabled } }));
    void persist(type, { enabled });
  }

  function handleToggle(type: PreferenceType, label: string, nextEnabled: boolean) {
    if (nextEnabled) {
      setEnabled(type, true);
      return;
    }
    // Turning OFF requires the Responsibility Check first — the toggle
    // doesn't flip until the dialog is confirmed.
    setPendingDisable(type);
  }

  function setLeadMinutes(type: PreferenceType, leadMinutes: number) {
    setState((prev) => ({ ...prev, [type]: { ...prev[type], leadMinutes } }));
    void persist(type, { lead_minutes: leadMinutes });
  }

  const pendingMeta = TYPE_META.find((m) => m.type === pendingDisable);

  return (
    <div className="mt-6 flex flex-col gap-3">
      <h2 className="text-lg font-bold">Notifications</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {TYPE_META.map((meta) => {
        const row = state[meta.type];
        return (
          <div key={meta.type} className="rounded-xl border border-foreground/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <label className="flex-1">
                <span className="block font-semibold">{meta.label}</span>
                <span className="block text-sm opacity-70">{meta.note}</span>
              </label>
              <input
                type="checkbox"
                role="switch"
                aria-checked={row.enabled}
                checked={row.enabled}
                disabled={savingType === meta.type}
                onChange={(e) => handleToggle(meta.type, meta.label, e.target.checked)}
                className="h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-foreground/20 transition-colors checked:bg-accent relative before:absolute before:left-0.5 before:top-0.5 before:h-5 before:w-5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-5 disabled:opacity-50"
              />
            </div>
            {meta.hasLead && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <span className="opacity-70">Lead time (minutes):</span>
                <input
                  type="number"
                  min={0}
                  max={180}
                  defaultValue={row.leadMinutes}
                  disabled={!row.enabled || savingType === meta.type}
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isFinite(value) && value >= 0 && value <= 180) setLeadMinutes(meta.type, value);
                    else e.target.value = String(row.leadMinutes);
                  }}
                  className="w-20 rounded-lg border border-foreground/20 bg-transparent px-2 py-1 disabled:opacity-50"
                />
              </label>
            )}
          </div>
        );
      })}

      <ResponsibilityCheckDialog
        open={pendingDisable !== null}
        typeLabel={pendingMeta?.label ?? ""}
        onCancel={() => setPendingDisable(null)}
        onConfirm={() => {
          if (pendingDisable) setEnabled(pendingDisable, false);
          setPendingDisable(null);
        }}
      />
    </div>
  );
}
