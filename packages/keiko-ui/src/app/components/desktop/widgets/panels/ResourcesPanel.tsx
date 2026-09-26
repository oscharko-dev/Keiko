"use client";

import type { ReactNode } from "react";

import { useTranslate } from "@/lib/i18n";

export function ResourcesPanel(): ReactNode {
  // A native <section aria-label> gives assistive tech a named landmark for this window's
  // content (matching the aria-label region pattern used elsewhere in the desktop shell) without
  // an explicit role="region" on a <div> (Sonar S6819: prefer <section> over role="region" — see
  // ExportBar.tsx and TerminalWidget.tsx for the same tradeoff already made in this codebase).
  const t = useTranslate();
  return (
    <section className="tw-pad" aria-label={t("window.type.resources.title")}>
      <div className="rb-placeholder" style={{ height: 150 }}>
        <div className="ph-stripes" />
        <span className="rb-ph-label mono">resources</span>
      </div>
      <div className="rb-foot mono" style={{ marginTop: 14 }}>
        {t("window.type.resources.desc")}
      </div>
    </section>
  );
}
