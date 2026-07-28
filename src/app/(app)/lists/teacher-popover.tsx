"use client";

import { useState } from "react";
import { REGION_LABELS } from "@/lib/auth/roles";
import type { Teacher } from "./types";

export default function TeacherPopover({ teacher }: { teacher: Teacher }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-2xl bg-surface-container p-3 text-left shadow-sm"
      >
        <span className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container"
            aria-hidden
          >
            <span className="material-symbols-outlined">person</span>
          </span>
          <span>
            <span className="font-medium text-on-surface">{teacher.full_name}</span>
            <span className="ml-2 text-xs text-on-surface-variant">
              {teacher.regions.length > 0
                ? teacher.regions.map((r) => REGION_LABELS[r]).join(", ")
                : "No region"}
            </span>
          </span>
        </span>
        <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-2xl bg-surface-container-high p-3 text-xs text-on-surface shadow-lg">
          <p className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-on-surface-variant" aria-hidden>
              mail
            </span>
            <span className="text-on-surface-variant">Email:</span>{" "}
            {teacher.email ?? <span className="text-outline">unknown</span>}
          </p>
          <p className="mt-1 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-on-surface-variant" aria-hidden>
              call
            </span>
            <span className="text-on-surface-variant">Phone:</span>{" "}
            {teacher.phone ?? <span className="text-outline">not set</span>}
          </p>
        </div>
      )}
    </div>
  );
}
