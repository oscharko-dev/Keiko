"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { createSupportReport, downloadSupportReport } from "@/lib/support-report-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import styles from "./SupportReportButton.module.css";

export function SupportReportButton({
  correlationId,
  compact = false,
}: {
  readonly correlationId?: string | undefined;
  readonly compact?: boolean;
}): ReactNode {
  const t = useTranslate();
  const [status, setStatus] = useState<"idle" | "busy" | "saved" | "error">("idle");
  useEffect(() => setStatus("idle"), [correlationId]);
  const create = async (): Promise<void> => {
    if (status === "busy") return;
    setStatus("busy");
    try {
      downloadSupportReport(await createSupportReport(correlationId));
      setStatus("saved");
    } catch (error) {
      setStatus("error");
      reportClientDiagnostic(`[keiko] support report failed: ${clientErrorSummary(error)}`, {
        correlationId: correlationIdOf(error),
        errorKind: bffRequestErrorKind(error),
      });
    }
  };
  return (
    <span className={styles.control}>
      <button
        type="button"
        className={compact ? "ft-seg" : "lk-btn"}
        disabled={status === "busy"}
        onClick={() => void create()}
      >
        {t(status === "busy" ? "supportReport.creating" : "supportReport.create")}
      </button>
      {status === "saved" || status === "error" ? (
        <span role="status" className={styles.feedback}>
          {t(status === "saved" ? "supportReport.saved" : "supportReport.failed")}
        </span>
      ) : null}
    </span>
  );
}
