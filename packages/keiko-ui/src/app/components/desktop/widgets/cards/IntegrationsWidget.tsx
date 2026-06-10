"use client";

import type { ReactNode } from "react";

interface App {
  readonly name: string;
  readonly desc: string;
  readonly glyph: string;
}

const APPS: readonly App[] = [
  { name: "Messaging", desc: "Catch up on threads", glyph: "#" },
  { name: "GitHub", desc: "PRs, code & CI", glyph: "{ }" },
  { name: "Linear", desc: "Track issues", glyph: "⊿" },
  { name: "Slack", desc: "Team channels", glyph: "≡" },
  { name: "Sentry", desc: "Error tracking", glyph: "◎" },
];

/**
 * Honest, non-interactive integrations overview (uiux-fix F023 C054/C380).
 * No real integration backend exists yet, so the rows are plain list items —
 * no buttons, no aria-pressed, no fabricated "connected" state — with an
 * explicit "Not connected" status so nothing suggests a clickable action.
 */
export function IntegrationsWidget(): ReactNode {
  return (
    <ul className="integ" aria-label="Integrations">
      {APPS.map((a) => (
        <li key={a.name} className="integ-row">
          <span className="integ-glyph mono">{a.glyph}</span>
          <span className="integ-text">
            <span className="integ-name">{a.name}</span>
            <span className="integ-desc">{a.desc}</span>
          </span>
          <span className="integ-status">Not connected — coming soon</span>
        </li>
      ))}
    </ul>
  );
}
