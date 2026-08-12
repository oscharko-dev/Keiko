"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";

interface AutomationRow {
  id: string;
  name: string;
  when: string;
}

const AUTOMATIONS: AutomationRow[] = [
  { id: "nightly-review", name: "Nightly review", when: "02:00 daily" },
  { id: "on-push-lint", name: "On push → lint", when: "git push" },
  { id: "weekly-digest", name: "Weekly digest", when: "Mon 09:00" },
];

export function AutomationsPanel(): ReactNode {
  const t = useTranslate();
  return (
    <div className="tw-list">
      {AUTOMATIONS.map((r) => (
        // GEN-UI-INTERACTION-002 (KEIKO-0158): automations are placeholders — no scheduler
        // is wired behind them. Render as non-interactive rows so they are NOT tab stops
        // and do not advertise switch semantics. The trailing "Preview" label makes it clear
        // no automation will actually execute; previously an "On" label misled sighted users
        // into believing a background job existed (Codex review on PR #3089).
        <div className="auto-row" key={r.id} data-state="preview">
          <span className="dot" style={{ background: "var(--fg-faint)" }} aria-hidden="true" />
          <span className="auto-text">
            <span className="auto-name">{r.name}</span>
            <span className="auto-when mono">{r.when}</span>
          </span>
          <span className="auto-when mono">{t("automations.status.preview")}</span>
        </div>
      ))}
    </div>
  );
}
