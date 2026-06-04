"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Toggle } from "../shared/Toggle";

interface AutomationRow {
  id: string;
  name: string;
  when: string;
  defaultOn: boolean;
}

const AUTOMATIONS: AutomationRow[] = [
  { id: "nightly-review", name: "Nightly review", when: "02:00 daily", defaultOn: true },
  { id: "on-push-lint", name: "On push → lint", when: "git push", defaultOn: true },
  { id: "weekly-digest", name: "Weekly digest", when: "Mon 09:00", defaultOn: false },
];

const STORE_KEY = "keiko.automations.v1";
const INITIAL: Record<string, boolean> = Object.fromEntries(
  AUTOMATIONS.map((r) => [r.id, r.defaultOn]),
);

function loadDefaults(): Record<string, boolean> {
  if (typeof window === "undefined") return { ...INITIAL };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return { ...INITIAL };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { ...INITIAL };
    const out: Record<string, boolean> = { ...INITIAL };
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k in INITIAL && typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return { ...INITIAL };
  }
}

export function AutomationsPanel(): ReactNode {
  const [state, setState] = useState<Record<string, boolean>>(loadDefaults);

  const toggle = (id: string): void => {
    setState((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? false) };
      if (typeof window !== "undefined") {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      }
      return next;
    });
  };

  return (
    <div className="tw-list">
      {AUTOMATIONS.map((r) => {
        const on = state[r.id] ?? r.defaultOn;
        return (
          <div className="auto-row" key={r.id}>
            <span
              className="dot"
              style={{ background: on ? "var(--accent)" : "var(--fg-faint)" }}
            />
            <span className="auto-text">
              <span className="auto-name">{r.name}</span>
              <span className="auto-when mono">{r.when}</span>
            </span>
            <Toggle
              on={on}
              onChange={() => {
                toggle(r.id);
              }}
              label={r.name}
            />
          </div>
        );
      })}
    </div>
  );
}
