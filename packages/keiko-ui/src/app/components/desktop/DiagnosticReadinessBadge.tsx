"use client";

// The footer's Activity Log readiness indicator (#3532). It renders nothing while diagnostic
// evidence is complete, or when no valid snapshot arrived, and otherwise an icon and a word with the
// closed reasons as its description, so a degraded evidence path is visible in the product and not
// only in a terminal. Component-scoped styling per the design-system styling register.

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
// footer can name it.
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

export function DiagnosticReadinessBadge({ snapshot }: DiagnosticReadinessBadgeProps): ReactNode {
  const t = useTranslate();
  if (snapshot === undefined || snapshot.readiness === "ready") return null;
  const label =
    snapshot.readiness === "degraded"
      ? t("footer.diagnosticsDegraded")
      : t("footer.diagnosticsUnavailable");
  const detail = t("footer.diagnosticsDetail", {
    reasons: snapshot.reasons.map((reason) => t(READINESS_REASON_MESSAGES[reason])).join(", "),
  });
  return (
    <span
      className={`ui-tip cmp-tip-start ${styles.cmpReadinessBadge}`}
      data-readiness={snapshot.readiness}
      data-tip={detail}
    >
      <ActivityIcon size={13} />
      <span className={styles.cmpReadinessLabel}>{label}</span>
      <span className="sr-only">{detail}</span>
    </span>
  );
}
