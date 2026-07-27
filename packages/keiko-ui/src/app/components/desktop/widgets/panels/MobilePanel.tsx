"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import styles from "./MobilePanel.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const MobileIcon = Icons.mobile;

export function MobilePanel(): ReactNode {
  return (
    <div className={`tw-pad mob ${styles.lazyWidgetScope}`}>
      <div className="mob-qr">
        <div className="ph-stripes" />
        <MobileIcon size={28} style={{ position: "relative", color: "var(--fg-dim)" }} />
      </div>
      <div className="mob-title">Keiko Mobile</div>
      <div className="mob-sub">Scan to continue this workspace on your phone.</div>
    </div>
  );
}
