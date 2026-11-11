"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { BackendHealth } from "./hooks/useBackendHealth";
import { SupportReportButton, useSupportReportPresence } from "./SupportReportButton";

const READINESS_REPORT_KEY = "diagnostic-readiness";

function memoryReadinessNotice(health: BackendHealth, t: I18nTranslate): ReactNode {
  if (health.state !== "loaded" || health.health.memory?.readiness !== "withheld") return null;
  const key =
    health.health.memory.reason === "vault-migration-failed"
      ? "memory.readiness.migrationFailed"
      : "memory.readiness.unreadable";
  return (
    <div className="source-limit-alert">
      <output>{t(key)}</output>
    </div>
  );
}

function readinessUnavailable(health: BackendHealth): boolean {
  if (health.state === "unavailable") return true;
  return (
    health.state === "loaded" &&
    (health.health.diagnosticsInvalid === true ||
      (health.health.diagnostics !== undefined && health.health.diagnostics.readiness !== "ready"))
  );
}

export function DiagnosticReadinessNotice({
  health,
}: {
  readonly health: BackendHealth;
}): ReactNode {
  const t = useTranslate();
  const report = health.state === "loading" ? undefined : health.report;
  const [previousReport, setPreviousReport] = useState(report);
  useEffect(() => {
    if (report !== undefined) setPreviousReport(report);
  }, [report]);
  const activeReport = report ?? previousReport;
  const hasReport = useSupportReportPresence(activeReport?.correlationId ?? READINESS_REPORT_KEY);
  const unavailable = readinessUnavailable(health);
  const memory = memoryReadinessNotice(health, t);
  if (!unavailable && !hasReport) return memory;
  return (
    <>
      {memory}
      <div className="source-limit-alert">
        {unavailable ? <output>{t("supportReport.readinessUnavailable")}</output> : null}
        <SupportReportButton
          compact
          errorKey={READINESS_REPORT_KEY}
          correlationId={activeReport?.correlationId}
          failure={activeReport?.failure}
          clientOnly={activeReport === undefined}
        />
      </div>
    </>
  );
}
