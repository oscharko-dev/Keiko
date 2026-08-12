"use client";

import type { ReactNode } from "react";
import styles from "./NotificationsPanel.module.css";

export function NotificationsPanel(): ReactNode {
  // GEN-UI-INTERACTION-004 (KEIKO-0158): no notification source is wired behind this panel.
  // Previously this rendered three hardcoded, never-changing entries inside an aria-live
  // log — content that looked live but could never change. Show an explicit empty state
  // instead so the placeholder is honest about having nothing to report.
  return (
    <div className={`tw-list ${styles.lazyWidgetScope}`}>
      <p className="nt-empty">No notifications yet.</p>
    </div>
  );
}
