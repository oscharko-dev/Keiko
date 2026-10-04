"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import type { BackendHealth } from "./hooks/useBackendHealth";
import { SupportReportButton } from "./SupportReportButton";

export function DiagnosticReadinessNotice({
  health,
}: {
  readonly health: BackendHealth;
}): ReactNode {
  const t = useTranslate();
  if (health.state === "loading") return null;
  if (health.state === "loaded") {
    const readiness = health.health.diagnostics?.readiness;
    if (readiness === undefined || readiness === "ready") return null;
  }
  return (
    <div className="source-limit-alert" role="status">
      <span>{t("supportReport.readinessUnavailable")}</span>
      <SupportReportButton compact failure={{ errorKind: "unavailable", context: [] }} />
    </div>
  );
}
