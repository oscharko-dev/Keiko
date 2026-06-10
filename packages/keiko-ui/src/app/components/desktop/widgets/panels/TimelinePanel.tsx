"use client";

import type { ReactNode } from "react";
import { useActivitySubscription } from "../shared/activityBus";
import type { ActivityEvent } from "../shared/activityBus";

const KIND_COLOR: Record<ActivityEvent["type"], string> = {
  step: "var(--fg-dim)",
  approval: "var(--warn)",
  approved: "var(--accent)",
  rejected: "var(--danger)",
  stopped: "var(--danger)",
  open: "var(--info)",
  "twin-approved": "var(--accent)",
  "twin-denied": "var(--danger)",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TimelinePanel(): ReactNode {
  const items = useActivitySubscription();

  return (
    // role="log" implies aria-live="polite": streamed entries are announced to assistive tech.
    <div className="tl" role="log" aria-label="Activity timeline">
      {items.length === 0 && (
        <div className="tl-empty">
          No activity yet.
          <br />
          Start an agent to see its actions stream here.
        </div>
      )}
      {items.map((e, i) => (
        <div className="tl-row" key={i}>
          <span
            className="tl-dot"
            aria-hidden="true"
            style={{ background: KIND_COLOR[e.type] ?? "var(--fg-faint)" }}
          />
          <div className="tl-body">
            {/* The event kind is otherwise only colour-coded via the dot (WCAG 1.4.1). */}
            <span className="visually-hidden">{e.type}</span>
            <span className="tl-text">{e.text}</span>
            <span className="tl-meta mono">
              {e.agent ?? "workspace"} · {formatTime(e.time)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
