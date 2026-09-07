"use client";

import { useEffect, type ReactNode } from "react";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts";
import { isVerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { CodingWorkbenchCommitBinding } from "./CodingWorkbenchCommitReview";
import styles from "./CodingWorkbenchWindow.module.css";

/** A final receipt explains the completed attempt; it cannot mint or reuse approval authority. */
export function CodingWorkbenchCommitResult({
  result,
  runId,
}: {
  readonly result: VerifiedCommitResult | undefined;
  readonly runId: string | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const receipt =
    isVerifiedCommitResult(result) &&
    result.runId === runId &&
    result.status !== "approval-required"
      ? result
      : null;
  const note =
    receipt === null
      ? null
      : `[keiko] verified commit result displayed: ${receipt.status} tree ${receipt.stagedTreeDigest.slice(0, 12)}`;
  useEffect(() => {
    if (note !== null) reportClientDiagnostic(note);
  }, [note, runId]);
  if (receipt === null) return null;
  return (
    <section className={styles.card} aria-label={t("codingWorkbench.commitResult.title")}>
      <h3 className={styles.approvalResearchTitle}>{t("codingWorkbench.commitResult.title")}</h3>
      <output>{t(`codingWorkbench.commitResult.status.${receipt.status}`)}</output>
      <p className={styles.helpText}>
        {t(`codingWorkbench.commitResult.reason.${receipt.reason}`)}
      </p>
      {receipt.headSha === undefined ? null : (
        <dl className={styles.approvalFacts}>
          <div className={styles.approvalFact}>
            <dt>{t("codingWorkbench.commitResult.head")}</dt>
            <dd>{receipt.headSha}</dd>
          </div>
        </dl>
      )}
      <CommitKernelFindings result={receipt} />
      <CodingWorkbenchCommitBinding result={receipt} t={t} />
    </section>
  );
}

function CommitKernelFindings({ result }: { readonly result: VerifiedCommitResult }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const git = useOptionalWidgetTranslate();
  if (
    result.blockReason === undefined &&
    result.preflightFindings === undefined &&
    result.violations === undefined
  )
    return null;
  return (
    <section
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.commitResult.findings")}
    >
      <h4 className={styles.approvalResearchTitle}>{t("codingWorkbench.commitResult.findings")}</h4>
      {result.blockReason === undefined ? null : (
        <p className={styles.helpText}>{git(`gitDelivery.blockReason.${result.blockReason}`)}</p>
      )}
      <ul className={styles.approvalChangedFiles}>
        {result.preflightFindings?.map((finding) => (
          <li key={finding.code}>
            <p className={styles.helpText}>
              {t(`codingWorkbench.commitResult.preflight.${finding.code}`)}
            </p>
            <p className={styles.helpText}>
              {git(`gitDelivery.blockerSeverity.${finding.severity}`)} ·{" "}
              {git(`gitDelivery.remediation.${finding.remediation}`)}
            </p>
          </li>
        ))}
        {result.violations?.map((code) => (
          <li key={code}>
            <p className={styles.helpText}>
              {t(`codingWorkbench.commitResult.messageViolation.${code}`)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
