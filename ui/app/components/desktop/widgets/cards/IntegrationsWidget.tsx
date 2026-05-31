"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

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

interface IntegrationsWidgetProps {
  provider?: string;
}

export function IntegrationsWidget({
  provider = "GitHub",
}: IntegrationsWidgetProps): ReactNode {
  return (
    <div className="integ">
      {APPS.map((a) => {
        const on = a.name === provider;
        return (
          <button
            key={a.name}
            type="button"
            className="integ-row"
            data-on={on}
            aria-pressed={on}
          >
            <span className="integ-glyph mono">{a.glyph}</span>
            <span className="integ-text">
              <span className="integ-name">{a.name}</span>
              <span className="integ-desc">{a.desc}</span>
            </span>
            {on ? (
              <span className="integ-on">
                <Icons.check size={13} />
              </span>
            ) : (
              <span className="integ-add">
                <Icons.plus size={14} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
