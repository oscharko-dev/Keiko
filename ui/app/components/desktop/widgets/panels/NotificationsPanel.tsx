"use client";

import type { ReactNode } from "react";

interface NotificationItem {
  t: string;
  time: string;
  c: string;
}

const ITEMS: NotificationItem[] = [
  { t: "Agent finished build-board", time: "2m", c: "var(--accent)" },
  { t: "diff-review ready to merge", time: "9m", c: "var(--info)" },
  { t: "lint-pass queued", time: "14m", c: "var(--fg-faint)" },
];

export function NotificationsPanel(): ReactNode {
  return (
    <div className="tw-list">
      {ITEMS.map((n, i) => (
        <div className="nt-row" key={i}>
          <span className="dot" style={{ background: n.c, marginTop: 6 }} />
          <span className="nt-text">
            <span className="nt-title">{n.t}</span>
            <span className="nt-time mono">{n.time} ago</span>
          </span>
        </div>
      ))}
    </div>
  );
}
