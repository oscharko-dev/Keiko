"use client";

// Activity Log readiness and saved-record status. Diagnostic retention is distinct from
// confirmed errors; degraded recording remains visible alongside the saved-record count.

import type { ReactNode } from "react";
import type {
  ActivityLogReadinessReason,
  ActivityLogReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { Icons } from "./Icons";
import styles from "./DiagnosticReadinessBadge.module.css";

// PascalCase alias so the JSX tag itself signals "component", not member access (S6770).
const ActivityIcon = Icons.activity;

// One message per closed reason: a reason added to the contract fails the typecheck here until the
// diagnostics surface can name it.
const READINESS_REASON_MESSAGES: Readonly<Record<ActivityLogReadinessReason, MessageKey>> = {
  "catalog-mismatch": "footer.diagnosticsReasonCatalogMismatch",
  "sink-unwritable": "footer.diagnosticsReasonSinkUnwritable",
  "storage-pressure": "footer.diagnosticsReasonStoragePressure",
  "budget-exceeded": "footer.diagnosticsReasonBudgetExceeded",
  "port-unwired": "footer.diagnosticsReasonPortUnwired",
  "level-silent": "footer.diagnosticsReasonLevelSilent",
  "storage-check-failed": "footer.diagnosticsReasonStorageCheckFailed",
};

interface DiagnosticReadinessBadgeProps {
  readonly snapshot: ActivityLogReadinessSnapshot | undefined;
}

function readinessText(
  snapshot: ActivityLogReadinessSnapshot,
  t: ReturnType<typeof useTranslate>,
): { readonly label: string | undefined; readonly detail: string | undefined } {
  const label =
    snapshot.readiness === "ready"
      ? undefined
      : snapshot.readiness === "degraded"
        ? t("footer.diagnosticsDegraded")
        : t("footer.diagnosticsUnavailable");
  const detail =
    snapshot.readiness === "ready"
      ? undefined
      : t("footer.diagnosticsDetail", {
          reasons: snapshot.reasons
            .map((reason) => t(READINESS_REASON_MESSAGES[reason]))
            .join(", "),
        });
  return { label, detail };
}

function retentionDetail(
  snapshot: ActivityLogReadinessSnapshot,
  t: ReturnType<typeof useTranslate>,
): string {
  const capacity = snapshot.diagnosticCapacity;
  const capacityDetail =
    capacity !== undefined && capacity > 0
      ? t("footer.diagnosticsRetentionCapacity", { capacity })
      : undefined;
  return [t("footer.diagnosticsRetainedDetail"), capacityDetail].filter(Boolean).join(" ");
}

export function DiagnosticReadinessBadge({ snapshot }: DiagnosticReadinessBadgeProps): ReactNode {
  const t = useTranslate();
  if (snapshot === undefined) return null;
  const count = snapshot.retainedDiagnosticCount ?? 0;
  if (snapshot.readiness === "ready" && count === 0) return null;
  const countLabel = count > 0 ? t("footer.diagnosticsRetained", { count }) : undefined;
  const { label: readinessLabel, detail: readinessDetail } = readinessText(snapshot, t);
  const detail = [readinessDetail, count > 0 ? retentionDetail(snapshot, t) : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={`ui-tip cmp-tip-start ${styles.cmpReadinessBadge}`}
      data-readiness={snapshot.readiness}
      data-tip={detail}
    >
      <ActivityIcon size={13} />
      {readinessLabel !== undefined ? (
        <span className={styles.cmpReadinessLabel}>{readinessLabel}</span>
      ) : null}
      {countLabel !== undefined ? (
        <span className={styles.cmpRetainedLabel}>{countLabel}</span>
      ) : null}
      <span className="sr-only">{detail}</span>
    </span>
  );
}
