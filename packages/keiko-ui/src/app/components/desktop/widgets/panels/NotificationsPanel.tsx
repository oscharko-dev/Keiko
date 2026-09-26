"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import styles from "./NotificationsPanel.module.css";

export function NotificationsPanel(): ReactNode {
  const t = useTranslate();
  // GEN-UI-INTERACTION-004 (KEIKO-0158): no notification source is wired behind this panel.
  // Codex on PR #3089 (3765778819): a bare empty-state reads as "working but empty inbox"
  // on restore; add an explicit in-panel Preview notice so the placeholder state is honest
  // on every open path (palette badge only fires on the palette-open path).
  return (
    <div className={`tw-list ${styles.lazyWidgetScope}`}>
      <p className="nt-empty">{t("notifications.empty")}</p>
      <p className="nt-empty mono" data-state="preview">
        {t("notifications.previewNotice")}
      </p>
    </div>
  );
}
