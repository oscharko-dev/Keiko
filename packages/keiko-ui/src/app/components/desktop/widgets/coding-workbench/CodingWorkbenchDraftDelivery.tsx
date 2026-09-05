"use client";

import { useEffect, type ReactNode } from "react";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { WorkbenchDescriptionStatus } from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

/** Durable facts only. A restored proposal does not restore approval authority. */
export function CodingWorkbenchDraftDelivery({
  snapshot,
  onReviewDescription,
}: {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | undefined;
  readonly onReviewDescription?: ((target: WorkbenchDescriptionReviewTarget) => void) | undefined;
}): ReactNode {
  const parsed = validateCodingWorkbenchRuntimeSnapshot(snapshot);
  const delivery = parsed.ok ? parsed.value.draftDelivery : undefined;
  const descriptionStatus = parsed.ok ? parsed.value.descriptionStatus : undefined;
  useDraftDeliveryDiagnostic(delivery, snapshot?.runId);
  if (delivery === undefined && descriptionStatus === undefined) return null;
  return (
    <>
      <DraftDeliveryCard delivery={delivery} />
      <WorkbenchDescriptionCard
        status={descriptionStatus}
        delivery={delivery}
        onReview={onReviewDescription}
      />
    </>
  );
}

function useDraftDeliveryDiagnostic(
  delivery: DraftDeliveryRecord | undefined,
  runId: string | undefined,
): void {
  const note =
    delivery === undefined
      ? null
      : `[keiko] draft delivery displayed: ${delivery.phase} reason ${delivery.reason} head ${delivery.binding.headSha.slice(0, 12)}`;
  useEffect(() => {
    if (note !== null) reportClientDiagnostic(note);
  }, [note, runId]);
}

// #3386/#3387: a "push-proposed"/"pr-proposed" phase is a pending delivery-substrate permission
// request (productionDraftDeliveryRuntime.ts `requestDraftDeliveryApproval` — actionKind "push" |
// "pull-request", actionClass "delivery-substrate"). This card stays read-only (Durable facts only,
// per its own contract above): the actual approve/deny control is the existing bounded-action review
// surface every other pending tool permission already uses (`codingWorkbench.approval.*`) — adding a
// second approve affordance here would be a duplicate authority for the SAME pending request. This
// hint only points the user at that existing surface.
const PENDING_APPROVAL_PHASES: ReadonlySet<DraftDeliveryRecord["phase"]> = new Set([
  "push-proposed",
  "pr-proposed",
]);

function PendingApprovalHint({
  phase,
}: {
  readonly phase: DraftDeliveryRecord["phase"];
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (!PENDING_APPROVAL_PHASES.has(phase)) return null;
  return (
    <p className={styles.helpText} data-testid="cwb-draft-delivery-approval-hint">
      {t("codingWorkbench.draftDelivery.pendingApprovalHint")}
    </p>
  );
}

function DraftDeliveryCard({
  delivery,
}: {
  readonly delivery: DraftDeliveryRecord | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (delivery === undefined) return null;
  return (
    <section className={styles.card} aria-label={t("codingWorkbench.draftDelivery.title")}>
      <h3 className={styles.approvalResearchTitle}>{t("codingWorkbench.draftDelivery.title")}</h3>
      <output>{t(`codingWorkbench.draftDelivery.phase.${delivery.phase}`)}</output>
      <p className={styles.helpText}>
        {t(`codingWorkbench.draftDelivery.reason.${delivery.reason}`)}
      </p>
      <PendingApprovalHint phase={delivery.phase} />
      <ObservedPullRequest delivery={delivery} t={t} />
      <DeliveryBinding delivery={delivery} t={t} />
    </section>
  );
}

export interface WorkbenchDescriptionReviewTarget {
  readonly ownerAndRepo: string;
  readonly prNumber: number;
  readonly proposalId: string;
  readonly snapshotDigest: string;
}

function descriptionReviewTarget(
  status: WorkbenchDescriptionStatus,
  delivery: DraftDeliveryRecord | undefined,
): WorkbenchDescriptionReviewTarget | undefined {
  const pullRequest = delivery?.pullRequest;
  if (
    status.proposalId === undefined ||
    status.snapshotDigest === null ||
    pullRequest?.state !== "open"
  ) {
    return undefined;
  }
  return {
    ownerAndRepo: pullRequest.repository,
    prNumber: pullRequest.number,
    proposalId: status.proposalId,
    snapshotDigest: status.snapshotDigest,
  };
}

// #3401: content-free status for the automatically generated description draft. Reviewing opens
// #3399's existing exact-proposal surface; approval and apply remain exclusively in that surface.
function WorkbenchDescriptionCard({
  status,
  delivery,
  onReview,
}: {
  readonly status: WorkbenchDescriptionStatus | undefined;
  readonly delivery: DraftDeliveryRecord | undefined;
  readonly onReview: ((target: WorkbenchDescriptionReviewTarget) => void) | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (status === undefined) return null;
  const reviewTarget = descriptionReviewTarget(status, delivery);
  return (
    <section className={styles.card} aria-label={t("codingWorkbench.descriptionStatus.title")}>
      <h3 className={styles.approvalResearchTitle}>
        {t("codingWorkbench.descriptionStatus.title")}
      </h3>
      <output>{t(`codingWorkbench.descriptionStatus.state.${status.state}`)}</output>
      <p className={styles.helpText}>
        {t(`codingWorkbench.descriptionStatus.reason.${status.reason}`)}
      </p>
      <DeliveryFacts
        facts={[
          {
            label: t("codingWorkbench.descriptionStatus.head"),
            value: status.headSha,
          },
          {
            label: t("codingWorkbench.descriptionStatus.generation"),
            value: String(status.generationVersion),
          },
        ]}
      />
      {reviewTarget !== undefined && onReview !== undefined ? (
        <button
          type="button"
          className={styles.button}
          onClick={() => onReview(reviewTarget)}
          data-testid="cwb-description-review"
        >
          {t("codingWorkbench.descriptionStatus.review")}
        </button>
      ) : null}
    </section>
  );
}

function ObservedPullRequest({
  delivery,
  t,
}: {
  readonly delivery: DraftDeliveryRecord;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const pr = delivery.pullRequest;
  if (pr === undefined) return null;
  const draftLabel = pr.isDraft ? "draft" : "notDraft";
  const observedState = t(`codingWorkbench.draftDelivery.remote.${pr.state}`);
  const observedDraft = t(`codingWorkbench.draftDelivery.remote.${draftLabel}`);
  return (
    <div className={styles.approvalResearch}>
      <a
        className={styles["cmp-draft-delivery-link"]}
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("codingWorkbench.draftDelivery.pullRequest", { number: pr.number })}
      </a>
      <DeliveryFacts
        facts={[
          {
            label: t("codingWorkbench.draftDelivery.remoteState"),
            value: `${observedState} · ${observedDraft}`,
          },
          { label: t("codingWorkbench.draftDelivery.remoteHead"), value: pr.headSha },
          { label: t("codingWorkbench.draftDelivery.remoteBase"), value: pr.baseSha },
        ]}
      />
    </div>
  );
}

function DeliveryBinding({
  delivery,
  t,
}: {
  readonly delivery: DraftDeliveryRecord;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <details className={styles.approvalResearch}>
      <summary className={styles["cmp-approval-commit-summary"]}>
        {t("codingWorkbench.draftDelivery.details")}
      </summary>
      <DeliveryBindingFacts delivery={delivery} t={t} />
    </details>
  );
}

export function DeliveryBindingFacts({
  delivery,
  t,
}: {
  readonly delivery: DraftDeliveryRecord;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const target = delivery.binding;
  return (
    <DeliveryFacts
      facts={[
        { label: t("codingWorkbench.draftDelivery.repository"), value: target.repository },
        {
          label: t("codingWorkbench.draftDelivery.issue"),
          value: `#${String(target.issueNumber)}`,
        },
        { label: t("codingWorkbench.draftDelivery.headRef"), value: target.headRef },
        { label: t("codingWorkbench.draftDelivery.headSha"), value: target.headSha },
        { label: t("codingWorkbench.draftDelivery.baseRef"), value: target.baseRef },
        { label: t("codingWorkbench.draftDelivery.baseSha"), value: target.baseSha },
        { label: t("codingWorkbench.draftDelivery.proposal"), value: delivery.proposalId },
        { label: t("codingWorkbench.draftDelivery.recordedAt"), value: delivery.recordedAt },
      ]}
    />
  );
}

function DeliveryFacts({
  facts,
}: {
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}): ReactNode {
  return (
    <dl className={styles.approvalFacts}>
      {facts.map(({ label, value }) => (
        <div className={styles.approvalFact} key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
