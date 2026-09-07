"use client";

import { useEffect, type ReactNode } from "react";
import type { CodingWorkbenchRuntimePendingPermission } from "@oscharko-dev/keiko-contracts";
import type { CodingRuntimeDeliveryReview } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type { UseCodingWorkbenchApprovalReviewResult } from "@/lib/useCodingWorkbenchApprovalReview";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { DeliveryBindingFacts } from "./CodingWorkbenchDraftDelivery";
import { RetryMessage } from "./CodingWorkbenchChanges";
import styles from "./CodingWorkbenchWindow.module.css";

type ActionKind = CodingWorkbenchRuntimePendingPermission["actionKind"];

export function isDeliveryPermission(kind: ActionKind): boolean {
  return kind === "push" || kind === "pull-request";
}

export function approvalHelpKey(kind: ActionKind): CodingWorkbenchMessageKey {
  if (kind === "commit") return "codingWorkbench.approval.commit.help";
  if (kind === "push") return "codingWorkbench.approval.delivery.pushHelp";
  if (kind === "pull-request") return "codingWorkbench.approval.delivery.prHelp";
  return "codingWorkbench.approval.help";
}

function deliveryReviewMessageKey(
  status: UseCodingWorkbenchApprovalReviewResult["status"],
): CodingWorkbenchMessageKey {
  return status === "loading"
    ? "codingWorkbench.approval.delivery.loading"
    : "codingWorkbench.approval.delivery.unavailable";
}

function deliveryRetry(
  state: UseCodingWorkbenchApprovalReviewResult,
  t: CodingWorkbenchTranslate,
): { readonly retry?: { readonly label: string; readonly onRetry: () => void | Promise<void> } } {
  return state.status === "unavailable"
    ? { retry: { label: t("codingWorkbench.approval.delivery.retry"), onRetry: state.retry } }
    : {};
}

/** Only the existing authenticated, permission-bound review supplies transient PR text. */
export function CodingWorkbenchDeliveryReview({
  state,
  t,
}: {
  readonly state: UseCodingWorkbenchApprovalReviewResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const review = state.review?.draftDelivery;
  useEffect(() => {
    reportClientDiagnostic(`[keiko] draft delivery review displayed: ${state.status}`);
  }, [state.status, state.review?.requestId]);
  return (
    <>
      <section
        className={styles.approvalResearch}
        aria-label={t("codingWorkbench.approval.delivery.target")}
      >
        <h3 className={styles.approvalResearchTitle}>
          {t("codingWorkbench.approval.delivery.target")}
        </h3>
        {review === undefined ? (
          <RetryMessage
            text={t(deliveryReviewMessageKey(state.status))}
            className={styles.approvalResearchDetail}
            {...deliveryRetry(state, t)}
          />
        ) : (
          <DeliveryBindingFacts delivery={review.record} t={t} />
        )}
      </section>
      <PullRequestText review={review} t={t} />
    </>
  );
}

function PullRequestText({
  review,
  t,
}: {
  readonly review: CodingRuntimeDeliveryReview | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (review === undefined || !("title" in review)) return null;
  return (
    <>
      <ReviewedText title={t("codingWorkbench.approval.delivery.title")} text={review.title} />
      <ReviewedText title={t("codingWorkbench.approval.delivery.body")} text={review.body} />
    </>
  );
}

function ReviewedText({
  title,
  text,
}: {
  readonly title: string;
  readonly text: string;
}): ReactNode {
  return (
    <section className={styles.approvalResearch} aria-label={title}>
      <h3 className={styles.approvalResearchTitle}>{title}</h3>
      <pre
        className={styles["cmp-approval-commit-message"]}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded review text must remain keyboard-scrollable
        tabIndex={0}
      >
        {text}
      </pre>
    </section>
  );
}
