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
  //
  // KEIKO-0867: the caption used to read "Scan to continue this workspace on your phone." — an
  // imperative instruction implying the QR-shaped `.ph-stripes` placeholder is a working pairing
  // affordance. It is purely decorative (no QR generation, no pairing endpoint), so the copy is
  // passive and self-disclosing instead: it never tells the user to act on something that cannot
  // succeed.
  //
  // A native <section aria-label> gives assistive tech a named landmark for this window's
  // content without an explicit role="region" on a <div> (Sonar S6819: prefer <section> over
  // role="region" — see ExportBar.tsx and TerminalWidget.tsx for the same tradeoff already made
  // in this codebase).
  return (
    <section
      className={`tw-pad mob ${styles.lazyWidgetScope}`}
      aria-label={t("window.type.mobile.title")}
    >
      <div className="mob-qr">
        <div className="ph-stripes" />
        <MobileIcon size={28} style={{ position: "relative", color: "var(--fg-dim)" }} />
      </div>
      <div className="mob-title">{t("window.type.mobile.title")}</div>
      <div className="mob-sub">{t("mobile.subtitle")}</div>
      <div className="mob-sub mono" data-state="preview">
        {t("mobile.previewNotice")}
      </div>
    </section>
  );
}
