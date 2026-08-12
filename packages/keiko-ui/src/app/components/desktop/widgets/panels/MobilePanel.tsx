"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "../../Icons";
import styles from "./MobilePanel.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const MobileIcon = Icons.mobile;

export function MobilePanel(): ReactNode {
  const t = useTranslate();
  // Codex on PR #3089 (3765676889): Palette's "Preview" badge only fires when the user opens
  // this window from the palette — a restored layout on reload never surfaces it. Show an
  // explicit in-panel Preview notice so the QR-shaped graphic is not read as a live pairing UI.
  return (
    <div className={`tw-pad mob ${styles.lazyWidgetScope}`}>
      <div className="mob-qr">
        <div className="ph-stripes" />
        <MobileIcon size={28} style={{ position: "relative", color: "var(--fg-dim)" }} />
      </div>
      <div className="mob-title">Keiko Mobile</div>
      <div className="mob-sub">Scan to continue this workspace on your phone.</div>
      <div className="mob-sub mono" data-state="preview">
        {t("mobile.previewNotice")}
      </div>
    </div>
  );
}
