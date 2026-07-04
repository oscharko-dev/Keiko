"use client";

import type { ReactNode } from "react";
import styles from "./NotificationsPanel.module.css";

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
    // GEN-UI-A11Y-014 — annotate as a polite log so future dynamic notifications are announced
    // to assistive tech (mirrors TerminalWidget's role=log usage). Data is static today.
    <ul
      className={`tw-list ${styles.lazyWidgetScope}`}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label="Notifications"
    >
      {ITEMS.map((n, i) => (
        <li className="nt-row" key={i}>
          <span className="dot" style={{ background: n.c, marginTop: 6 }} aria-hidden="true" />
          <span className="nt-text">
            <span className="nt-title">{n.t}</span>
            <span className="nt-time mono">{n.time} ago</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
