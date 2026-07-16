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
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-foreground/10 p-3 text-left hover:border-foreground/30"
      >
        <span>
          <span className="font-medium">{teacher.full_name}</span>
          <span className="ml-2 text-xs opacity-60">
            {teacher.region ? REGION_LABELS[teacher.region] : "No region"}
          </span>
        </span>
        <span className="text-xs opacity-50">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-xl border border-foreground/10 bg-background p-3 text-xs shadow-lg">
          <p>
            <span className="opacity-60">Email:</span>{" "}
            {teacher.email ?? <span className="opacity-40">unknown</span>}
          </p>
          <p className="mt-1">
            <span className="opacity-60">Phone:</span>{" "}
            {teacher.phone ?? <span className="opacity-40">not set</span>}
          </p>
        </div>
      )}
    </div>
  );
}
