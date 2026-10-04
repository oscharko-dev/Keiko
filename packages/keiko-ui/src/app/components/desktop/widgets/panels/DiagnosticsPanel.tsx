"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { DiagnosticReadinessBadge } from "../../DiagnosticReadinessBadge";
import { GlobalSupportReportAction } from "../../SupportReportButton";
import { useBackendHealth } from "../../hooks/useBackendHealth";
import styles from "./DiagnosticsPanel.module.css";

export function DiagnosticsPanel(): ReactNode {
  const t = useTranslate();
  const health = useBackendHealth();
  const snapshot = health.state === "loaded" ? health.health.diagnostics : undefined;
  const status =
    health.state === "loading"
      ? t("diagnostics.loading")
      : snapshot === undefined
        ? t("diagnostics.unavailable")
        : snapshot.readiness === "ready"
          ? t("diagnostics.recordingReady")
          : undefined;
  return (
    <section className={styles.cmpPanel} aria-label={t("window.type.diagnostics.title")}>
      <h2>{t("window.type.diagnostics.title")}</h2>
      <p>{t("diagnostics.description")}</p>
      <div className={styles.cmpStatus} aria-live="polite">
        {status === undefined ? null : <p>{status}</p>}
        <DiagnosticReadinessBadge snapshot={snapshot} />
        {snapshot !== undefined && (snapshot.retainedDiagnosticCount ?? 0) === 0 ? (
          <p>{t("diagnostics.noRetainedCases")}</p>
        ) : null}
      </div>
      <GlobalSupportReportAction />
    </section>
  );
}
