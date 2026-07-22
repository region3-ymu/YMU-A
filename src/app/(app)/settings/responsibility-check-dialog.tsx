"use client";

import { useState } from "react";

// Required before disabling ANY notification type (brief: "Responsibility
// Check double-confirmation dialog"). Two distinct affirmative actions, not
// one dialog with a single OK: step 1 states the consequence and requires
// "Continue"; step 2 requires ticking an explicit acknowledgement checkbox
// before "Turn off" even becomes clickable. Only gates turning OFF — turning
// a type back on needs no confirmation.
export default function ResponsibilityCheckDialog({
  open,
  typeLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  typeLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [acknowledged, setAcknowledged] = useState(false);

  if (!open) return null;

  function reset() {
    setStep(1);
    setAcknowledged(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="responsibility-check-title"
    >
      <div className="w-full max-w-sm rounded-2xl border border-foreground/10 bg-background p-6 shadow-xl">
        {step === 1 ? (
          <>
            <h2 id="responsibility-check-title" className="text-lg font-bold">
              Turn off &ldquo;{typeLabel}&rdquo;?
            </h2>
            <p className="mt-2 text-sm opacity-80">
              You won&apos;t be notified about this anymore. If that leads to a missed clock-in, a missed clock-out, or
              a missed schedule change, no reminder will catch it — checking for it becomes your responsibility.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  reset();
                  onCancel();
                }}
                className="rounded-lg px-3 py-1.5 text-sm font-semibold opacity-70"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white"
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="responsibility-check-title" className="text-lg font-bold">
              Are you sure?
            </h2>
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I understand I&apos;m turning off &ldquo;{typeLabel}&rdquo; and accept responsibility for checking it
                myself from now on.
              </span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  reset();
                  onCancel();
                }}
                className="rounded-lg px-3 py-1.5 text-sm font-semibold opacity-70"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!acknowledged}
                onClick={() => {
                  reset();
                  onConfirm();
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                Turn off
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
