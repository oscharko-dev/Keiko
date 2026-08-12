"use client";

import type { ReactNode } from "react";

interface AutomationRow {
  id: string;
  name: string;
  when: string;
  on: boolean;
}

const AUTOMATIONS: AutomationRow[] = [
  { id: "nightly-review", name: "Nightly review", when: "02:00 daily", on: true },
  { id: "on-push-lint", name: "On push → lint", when: "git push", on: true },
  { id: "weekly-digest", name: "Weekly digest", when: "Mon 09:00", on: false },
];

export function AutomationsPanel(): ReactNode {
  return (
    <div className="tw-list">
      {AUTOMATIONS.map((r) => (
        // GEN-UI-INTERACTION-002 (KEIKO-0158): automations are placeholders — no scheduler
        // is wired behind them. Render as non-interactive rows so they are NOT tab stops
        // and do not advertise switch semantics — the "On/Off" copy carries the status.
        // Mirrors PluginsPanel's Connectors section (GEN-UI-INTERACTION-001).
        <div className="auto-row" key={r.id} data-on={r.on}>
          <span
            className="dot"
            style={{ background: r.on ? "var(--accent)" : "var(--fg-faint)" }}
            aria-hidden="true"
          />
          <span className="auto-text">
            <span className="auto-name">{r.name}</span>
            <span className="auto-when mono">{r.when}</span>
          </span>
          <span className="auto-when mono">{r.on ? "On" : "Off"}</span>
        </div>
      ))}
    </div>
  );
}
