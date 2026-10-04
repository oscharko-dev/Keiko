"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import type { BackendHealth } from "./hooks/useBackendHealth";
import { SupportReportButton, useSupportReportPresence } from "./SupportReportButton";

const READINESS_REPORT_KEY = "diagnostic-readiness";

function readinessUnavailable(health: BackendHealth): boolean {
  if (health.state === "unavailable") return true;
  return (
    health.state === "loaded" &&
    health.health.diagnostics !== undefined &&
    health.health.diagnostics.readiness !== "ready"
  );
}

export function DiagnosticReadinessNotice({
  health,
}: {
  readonly health: BackendHealth;
}): ReactNode {
  const t = useTranslate();
  const hasReport = useSupportReportPresence(READINESS_REPORT_KEY);
  const unavailable = readinessUnavailable(health);
  if (!unavailable && !hasReport) return null;
  return (
    <div className="source-limit-alert">
      {unavailable ? <output>{t("supportReport.readinessUnavailable")}</output> : null}
      <SupportReportButton
        compact
        errorKey={READINESS_REPORT_KEY}
        failure={{ errorKind: "unavailable", context: [] }}
      />
    </div>
  );
}
