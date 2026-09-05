"use client";

import { useEffect, type ReactNode } from "react";
import type {
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimePendingApprovalReview,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { UseCodingWorkbenchApprovalReviewResult } from "@/lib/useCodingWorkbenchApprovalReview";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

type CommitReview = NonNullable<CodingWorkbenchRuntimePendingApprovalReview["verifiedCommit"]>;

export function StageReviewDiagnostic({
  kind,
  status,
  fileCount,
}: {
  readonly kind: CodingWorkbenchRuntimePendingPermission["actionKind"];
  readonly status: UseCodingWorkbenchApprovalReviewResult["status"];
  readonly fileCount: number;
}): null {
  useEffect(() => {
    if (kind !== "git-stage") return;
    reportClientDiagnostic(`[keiko] git stage review ${status}: files ${String(fileCount)}`);
  }, [kind, status, fileCount]);
  return null;
}

export function approvalReviewRequestId(
  request: CodingWorkbenchRuntimePendingPermission | undefined,
): string | undefined {
  switch (request?.actionKind) {
    case "file-edit":
    case "git-stage":
    case "commit":
    case "push":
    case "pull-request":
      return request.requestId;
    default:
      return undefined;
  }
}

/** The snapshot and authenticated review may advance independently; never display a foreign proposal. */
export function reviewForPermission(
  state: UseCodingWorkbenchApprovalReviewResult,
  request: CodingWorkbenchRuntimePendingPermission,
  snapshot: CodingWorkbenchRuntimeSnapshot | undefined,
): UseCodingWorkbenchApprovalReviewResult {
  if (state.status !== "ready") return { ...state, review: null };
  const review = state.review;
  const validated = validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending: review,
  });
  if (
    !validated.ok ||
    review?.requestId !== request.requestId ||
    !commitMatchesPermission(review, request, snapshot?.runId) ||
    !deliveryMatchesPermission(review, request, snapshot)
  ) {
    return { ...state, status: "unavailable", review: null };
  }
  return state;
}

function commitMatchesPermission(
  review: CodingWorkbenchRuntimePendingApprovalReview | null,
  request: CodingWorkbenchRuntimePendingPermission,
  runId: string | undefined,
): boolean {
  const commit = review?.verifiedCommit;
  return request.actionKind === "commit"
    ? commit !== undefined && commit.result.runId === runId
    : commit === undefined;
}

function deliveryMatchesPermission(
  review: CodingWorkbenchRuntimePendingApprovalReview | null,
  request: CodingWorkbenchRuntimePendingPermission,
  snapshot: CodingWorkbenchRuntimeSnapshot | undefined,
): boolean {
  const delivery = review?.draftDelivery;
  if (request.actionKind !== "push" && request.actionKind !== "pull-request")
    return delivery === undefined;
  if (delivery === undefined || snapshot === undefined) return false;
  const phase = request.actionKind === "push" ? "push-proposed" : "pr-proposed";
  return (
    delivery.record.phase === phase &&
    validateCodingWorkbenchRuntimeSnapshot({
      ...snapshot,
      draftDelivery: delivery.record,
    }).ok
  );
}

export function CodingWorkbenchCommitReview({
  commit,
  t,
}: {
  readonly commit: CommitReview | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (commit === undefined) return null;
  return (
    <>
      <section
        className={styles.approvalResearch}
        aria-label={t("codingWorkbench.approval.commit.message")}
      >
        <h3 className={styles.approvalResearchTitle}>
          {t("codingWorkbench.approval.commit.message")}
        </h3>
        <pre
          className={styles["cmp-approval-commit-message"]}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded message scroll region must be keyboard reachable
          tabIndex={0}
        >
          {commit.message}
        </pre>
      </section>
      <CodingWorkbenchCommitBinding result={commit.result} t={t} />
    </>
  );
}

export function CodingWorkbenchCommitBinding({
  result,
  t,
}: {
  readonly result: CommitReview["result"];
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <details className={styles.approvalResearch}>
      <summary className={styles["cmp-approval-commit-summary"]}>
        {t("codingWorkbench.approval.commit.binding")}
      </summary>
      <dl className={styles.approvalFacts}>
        {commitBindingFacts(result, t).map(({ label, value }) => (
          <div className={styles.approvalFact} key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function commitBindingFacts(
  result: CommitReview["result"],
  t: CodingWorkbenchTranslate,
): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: t("codingWorkbench.approval.commit.proposal"), value: result.proposalId },
    {
      label: t("codingWorkbench.approval.commit.verification"),
      value: result.verificationEvidenceId,
    },
    { label: t("codingWorkbench.approval.commit.base"), value: result.baseSha },
    { label: t("codingWorkbench.approval.commit.parent"), value: result.parentSha },
    { label: t("codingWorkbench.approval.commit.tree"), value: result.stagedTreeDigest },
    { label: t("codingWorkbench.approval.commit.messageDigest"), value: result.messageDigest },
  ];
}
