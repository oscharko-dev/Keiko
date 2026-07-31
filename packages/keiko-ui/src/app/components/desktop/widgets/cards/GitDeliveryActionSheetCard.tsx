"use client";

// Governed Git delivery approval surface (Issue #473, Epic #470). Renders the UI-safe
// GitDeliveryActionSheet projection — a content-free manifest of counts, flags, branch names, and
// typed codes — with three visually AND programmatically distinct states (AC1/AC3):
//   • ready-to-execute   → the confirm/execute affordance is enabled
//   • waiting-for-approval → confirm is disabled; an Approve affordance + required approvers show
//   • blocked            → the blocked cause + expected blockers show; confirm is disabled
// plus an always-visible recovery-hints region (AC4) and the visible policy explanation + preview
// manifest (AC1/AC2). This surface NEVER executes the mutation (execution is a later slice); the
// confirm affordance only emits the intent. It carries no diff content, file paths, secrets, or
// command strings — there are none in the contract.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type {
  GitDeliveryActionSheet,
  GitDeliveryActionSheetState,
  GitDeliveryApprovalNecessity,
  GitDeliveryApprovalSummary,
  GitDeliveryBlockedCause,
  GitDeliveryBlockedDetail,
  GitDeliveryBlockReason,
  GitDeliveryBlockerSeverity,
  GitDeliveryBlockerSource,
  GitDeliveryConstraint,
  GitDeliveryExpectedBlocker,
  GitDeliveryPolicyExplanation,
  GitDeliveryPreviewManifest,
  GitDeliveryRecoveryActionHint,
  GitDeliveryRecoveryHint,
  GitDeliveryRecoveryStrategyHint,
  GitDeliveryRemediationClass,
  GitDeliveryRiskClass,
} from "@oscharko-dev/keiko-contracts";
import { ApiError, fetchGitDeliveryActionSheet } from "@/lib/api";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import { Icons } from "../../Icons";

const GitIcon = Icons.git;

// ─── Display label maps (typed codes → human text; never colour-alone) ─────────────────

function stateLabel(state: GitDeliveryActionSheetState, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.state.${state}`);
}

function necessityLabel(value: GitDeliveryApprovalNecessity, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.necessity.${value}`);
}

function riskClassLabel(value: GitDeliveryRiskClass, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.risk.${value}`);
}

function blockedCauseLabel(value: GitDeliveryBlockedCause, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.blockedCause.${value}`);
}

function blockerSourceLabel(value: GitDeliveryBlockerSource, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.blockerSource.${value}`);
}

function blockerSeverityLabel(
  value: GitDeliveryBlockerSeverity,
  t: OptionalWidgetTranslate,
): string {
  return t(`gitDelivery.blockerSeverity.${value}`);
}

function remediationLabel(value: GitDeliveryRemediationClass, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.remediation.${value}`);
}

function blockReasonLabel(value: GitDeliveryBlockReason, t: OptionalWidgetTranslate): string {
  return t(`gitDelivery.blockReason.${value}`);
}

function policyDecisionLabel(
  value: GitDeliveryPolicyExplanation["decision"],
  t: OptionalWidgetTranslate,
): string {
  return t(`gitDelivery.policyDecision.${value}`);
}

function recoveryHintLabel(
  value: GitDeliveryRecoveryActionHint,
  t: OptionalWidgetTranslate,
): string {
  return t(`gitDelivery.recoveryHint.${value}`);
}

function recoveryStrategyLabel(
  value: GitDeliveryRecoveryStrategyHint,
  t: OptionalWidgetTranslate,
): string {
  return t(`gitDelivery.recoveryStrategy.${value}`);
}

function constraintLabel(constraint: GitDeliveryConstraint, t: OptionalWidgetTranslate): string {
  switch (constraint.kind) {
    case "branch-pattern":
      return t("gitDelivery.constraint.branchPattern", {
        patterns: constraint.patterns.map((p) => `${p.matchKind} "${p.value}"`).join(", "),
      });
    case "protected-branch":
      return t("gitDelivery.constraint.protectedBranch", {
        patterns: constraint.patterns.map((p) => `${p.matchKind} "${p.value}"`).join(", "),
      });
    case "provider-capability":
      return t("gitDelivery.constraint.providerCapability", { capability: constraint.capability });
    case "risk-class-ceiling":
      return t("gitDelivery.constraint.riskCeiling", {
        risk: riskClassLabel(constraint.maxRiskClass, t),
      });
    default: {
      // Exhaustive: a new GitDeliveryConstraint kind must update this switch (compile-time error).
      const unreachable: never = constraint;
      return unreachable;
    }
  }
}

function formatError(err: unknown, t: OptionalWidgetTranslate): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return t("gitDelivery.error.unexpected");
}

// ─── Preview manifest (AC2) ────────────────────────────────────────────────────────────

function remoteImpactLabels(
  preview: GitDeliveryPreviewManifest,
  t: OptionalWidgetTranslate,
): readonly string[] {
  const labels = [
    preview.touchesRemote
      ? t("gitDelivery.remote.touchesRemote")
      : t("gitDelivery.remote.localOnly"),
  ];
  if (preview.wouldCreateRemoteBranch) labels.push(t("gitDelivery.remote.createBranch"));
  if (preview.wouldForcePublish) labels.push(t("gitDelivery.remote.forcePublish"));
  if (preview.wouldTriggerChecks) labels.push(t("gitDelivery.remote.triggerChecks"));
  return labels;
}

function PreviewBranchDetails({
  preview,
  t,
}: {
  readonly preview: GitDeliveryPreviewManifest;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <>
      {preview.affectedBranchName !== undefined ? (
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.affectedBranch")}</dt>
          <dd className="gdas-mono">{preview.affectedBranchName}</dd>
        </div>
      ) : null}
      {preview.baseBranchName !== undefined ? (
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.baseBranch")}</dt>
          <dd className="gdas-mono">{preview.baseBranchName}</dd>
        </div>
      ) : null}
      {preview.remoteBranchName !== undefined ? (
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.remoteBranch")}</dt>
          <dd className="gdas-mono">{preview.remoteBranchName}</dd>
        </div>
      ) : null}
      {preview.estimatedFileCount !== undefined ? (
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.filesAffected")}</dt>
          <dd>{preview.estimatedFileCount.toString()}</dd>
        </div>
      ) : null}
      {preview.estimatedBytesDelta !== undefined ? (
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.bytesDelta")}</dt>
          <dd>{preview.estimatedBytesDelta.toString()}</dd>
        </div>
      ) : null}
    </>
  );
}

function PreviewReadinessDetails({
  preview,
  t,
}: {
  readonly preview: GitDeliveryPreviewManifest;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <>
      {preview.pullRequest !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-pr">
          {t("gitDelivery.preview.pullRequest", {
            status: preview.pullRequest.status,
            draft: preview.pullRequest.isDraft ? t("gitDelivery.preview.draftSuffix") : "",
            received: preview.pullRequest.mergeReadiness.receivedApprovalCount,
            required: preview.pullRequest.mergeReadiness.requiredApprovalCount,
          })}
        </p>
      ) : null}
      {preview.mergeReadiness !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-merge">
          {t("gitDelivery.preview.mergeReadiness", {
            state: preview.mergeReadiness.ready
              ? t("gitDelivery.preview.readyToMerge")
              : t("gitDelivery.preview.notReadyToMerge"),
          })}
          {preview.mergeReadiness.blockingReason !== undefined
            ? ` (${preview.mergeReadiness.blockingReason})`
            : ""}{" "}
          ·{" "}
          {t("gitDelivery.preview.approvals", {
            received: preview.mergeReadiness.receivedApprovalCount,
            required: preview.mergeReadiness.requiredApprovalCount,
          })}
        </p>
      ) : null}
      {preview.branchProtection !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-protection">
          {t("gitDelivery.preview.branchProtection", {
            reviews: preview.branchProtection.requiredReviewCount,
            checks: preview.branchProtection.requiredStatusCheckCount,
          })}
        </p>
      ) : null}
      {preview.checks !== undefined ? (
        <>
          <p className="gdas-preview-line" data-testid="gdas-preview-checks">
            {t("gitDelivery.preview.checks", {
              status: preview.checks.overallStatus,
              passing: preview.checks.passing,
              failing: preview.checks.failing,
              pending: preview.checks.pending,
              total: preview.checks.total,
            })}
          </p>
          {preview.checks.informational !== undefined ? (
            <p className="gdas-preview-line" data-testid="gdas-preview-informational-checks">
              {t("gitDelivery.preview.informationalChecks", {
                status: preview.checks.informational.overallStatus,
                passing: preview.checks.informational.passing,
                failing: preview.checks.informational.failing,
                pending: preview.checks.informational.pending,
                total: preview.checks.informational.total,
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function PreviewSection({
  preview,
  t,
}: {
  readonly preview: GitDeliveryPreviewManifest;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const remoteImpact = remoteImpactLabels(preview, t);
  return (
    <section className="gdas-section" aria-label={t("gitDelivery.preview.ariaLabel")}>
      <h4 className="gdas-section-title">{t("gitDelivery.preview.title")}</h4>
      <dl className="gdas-preview">
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.action")}</dt>
          <dd>{preview.actionKind}</dd>
        </div>
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.risk")}</dt>
          <dd>
            {t("gitDelivery.preview.riskValue", {
              risk: riskClassLabel(preview.riskClass, t),
              severity: preview.riskSeverity,
            })}
          </dd>
        </div>
        <PreviewBranchDetails preview={preview} t={t} />
        <div className="gdas-kv">
          <dt>{t("gitDelivery.preview.remoteImpact")}</dt>
          <dd>{remoteImpact.join(" · ")}</dd>
        </div>
      </dl>
      <PreviewReadinessDetails preview={preview} t={t} />
    </section>
  );
}

// ─── Approval + policy explanation (AC1) ─────────────────────────────────────────────────

function ApprovalSection({
  approval,
  policyExplanation,
  t,
}: {
  readonly approval: GitDeliveryApprovalSummary;
  readonly policyExplanation: GitDeliveryPolicyExplanation;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const necessitySuffix = approval.satisfied
    ? t("gitDelivery.approval.satisfiedSuffix")
    : t("gitDelivery.approval.unsatisfiedSuffix");
  return (
    <section className="gdas-section" aria-label={t("gitDelivery.approval.ariaLabel")}>
      <h4 className="gdas-section-title">{t("gitDelivery.approval.title")}</h4>
      <dl className="gdas-preview">
        <div className="gdas-kv">
          <dt>{t("gitDelivery.approval.title")}</dt>
          <dd data-testid="gdas-necessity">
            {necessityLabel(approval.necessity, t)}
            {approval.necessity === "required" ? necessitySuffix : ""}
          </dd>
        </div>
        <div className="gdas-kv">
          <dt>{t("gitDelivery.approval.policyDecision")}</dt>
          <dd data-testid="gdas-policy-decision">
            {policyDecisionLabel(policyExplanation.decision, t)}
          </dd>
        </div>
        {policyExplanation.blockReason !== undefined ? (
          <div className="gdas-kv">
            <dt>{t("gitDelivery.approval.reason")}</dt>
            <dd data-testid="gdas-block-reason">
              {blockReasonLabel(policyExplanation.blockReason, t)}
            </dd>
          </div>
        ) : null}
      </dl>
      {policyExplanation.requiredApprovers.length > 0 ? (
        <div className="gdas-approvers" data-testid="gdas-required-approvers">
          <span className="gdas-section-subtitle">
            {t("gitDelivery.approval.requiredApprovers")}
          </span>
          <ul
            className="gdas-approver-list"
            aria-label={t("gitDelivery.approval.requiredApprovers")}
          >
            {policyExplanation.requiredApprovers.map((approver) => (
              <li key={approver} className="gdas-mono">
                {approver}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {policyExplanation.constraints.length > 0 ? (
        <div className="gdas-constraints">
          <span className="gdas-section-subtitle">{t("gitDelivery.approval.constraints")}</span>
          <ul
            className="gdas-constraint-list"
            aria-label={t("gitDelivery.approval.constraintsAriaLabel")}
          >
            {policyExplanation.constraints.map((constraint, index) => (
              <li key={`${constraint.kind}-${index.toString()}`}>
                {constraintLabel(constraint, t)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ─── Expected blockers list (AC2/AC3) ────────────────────────────────────────────────────

function ExpectedBlockerList({
  blockers,
  label,
  t,
}: {
  readonly blockers: readonly GitDeliveryExpectedBlocker[];
  readonly label: string;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (blockers.length === 0) return null;
  return (
    <ul className="gdas-blocker-list" aria-label={label}>
      {blockers.map((blocker, index) => (
        <li
          key={`${blocker.source}-${blocker.reasonCode}-${index.toString()}`}
          className="gdas-blocker"
          data-severity={blocker.severity}
          // Both the visible badges and this accessible name carry every typed field, so the
          // severity is never conveyed by colour alone (AC5).
          aria-label={t("gitDelivery.blocker.ariaLabel", {
            severity: blockerSeverityLabel(blocker.severity, t),
            source: blockerSourceLabel(blocker.source, t),
            code: blocker.reasonCode,
            remediation: remediationLabel(blocker.remediation, t),
          })}
        >
          <span className="gdas-blocker-badges" aria-hidden="true">
            <span className="gdas-badge gdas-badge-source">
              {blockerSourceLabel(blocker.source, t)}
            </span>
            <span className="gdas-badge" data-severity={blocker.severity}>
              {blockerSeverityLabel(blocker.severity, t)}
            </span>
          </span>
          <span className="gdas-mono gdas-blocker-code" aria-hidden="true">
            {blocker.reasonCode}
          </span>
          <span className="gdas-blocker-remediation" aria-hidden="true">
            {remediationLabel(blocker.remediation, t)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BlockedSection({
  blocked,
  t,
}: {
  readonly blocked: GitDeliveryBlockedDetail;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <section className="gdas-section gdas-blocked" aria-label={t("gitDelivery.blocked.ariaLabel")}>
      <h4 className="gdas-section-title">{t("gitDelivery.blocked.title")}</h4>
      <p className="gdas-blocked-cause" data-testid="gdas-blocked-cause">
        {blockedCauseLabel(blocked.cause, t)}
      </p>
      <ExpectedBlockerList
        blockers={blocked.expectedBlockers}
        label={t("gitDelivery.blocked.conditions")}
        t={t}
      />
    </section>
  );
}

// ─── Recovery hints (AC4 — in the same surface) ───────────────────────────────────────────

function RecoverySection({
  recovery,
  t,
}: {
  readonly recovery: readonly GitDeliveryRecoveryHint[];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (recovery.length === 0) return null;
  return (
    <section
      className="gdas-section gdas-recovery"
      aria-label={t("gitDelivery.recovery.ariaLabel")}
    >
      <h4 className="gdas-section-title">{t("gitDelivery.recovery.title")}</h4>
      <ul className="gdas-recovery-list" aria-label={t("gitDelivery.recovery.listAriaLabel")}>
        {recovery.map((hint, index) => {
          const strategy =
            hint.suggestedRecoveryStrategy !== undefined
              ? t("gitDelivery.recovery.strategySentence", {
                  strategy: recoveryStrategyLabel(hint.suggestedRecoveryStrategy, t),
                })
              : "";
          return (
            <li
              key={`${hint.actionHint}-${index.toString()}`}
              className="gdas-recovery-item"
              data-testid="gdas-recovery-item"
            >
              <span className="gdas-recovery-action">{recoveryHintLabel(hint.actionHint, t)}</span>
              <span className="gdas-recovery-remediation">
                {remediationLabel(hint.remediation, t)}
              </span>
              {hint.suggestedRecoveryStrategy !== undefined ? (
                <span className="gdas-recovery-strategy" data-testid="gdas-recovery-strategy">
                  {t("gitDelivery.recovery.strategy", {
                    strategy: recoveryStrategyLabel(hint.suggestedRecoveryStrategy, t),
                  })}
                </span>
              ) : null}
              {/* Carry the full hint (action + remediation + strategy) in one accessible string so
                  nothing relies on colour or layout alone. */}
              <span className="sr-only">
                {recoveryHintLabel(hint.actionHint, t)}. {remediationLabel(hint.remediation, t)}.
                {strategy}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Pure presentation body ──────────────────────────────────────────────────────────────

interface GitDeliveryActionSheetViewProps {
  readonly actionSheet: GitDeliveryActionSheet;
  readonly onApprove?: (() => void) | undefined;
  readonly onConfirm?: (() => void) | undefined;
  readonly onReject?: (() => void) | undefined;
}

function GitDeliveryActionSheetView({
  actionSheet,
  onApprove,
  onConfirm,
  onReject,
}: GitDeliveryActionSheetViewProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const titleId = useId();
  const stateId = useId();
  const waiting = actionSheet.state === "waiting-for-approval";
  const blocked = actionSheet.state === "blocked";
  const ready = actionSheet.state === "ready-to-execute";

  // GEN-UI-A11Y-006 — this is an inline embedded card, not a modal: it has no focus trap and no
  // modality (its comment notes it never executes the mutation). Grabbing focus on mount would
  // hijack the reading order of the surrounding surface, so we do NOT auto-focus. The container is
  // a named role="group" (see below) and the Escape-to-reject shortcut remains for keyboard users.

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && onReject !== undefined) {
      event.stopPropagation();
      onReject();
    }
  };

  return (
    // GEN-UI-A11Y-006 — non-modal embedded card: role="group" (an accessibly-named container),
    // NOT role="alertdialog" (which would falsely promise a focus trap + modality this inline card
    // does not provide). Escape-to-reject is retained for keyboard users.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-reject on the group container mirrors the Reject button for keyboard users
    <div
      className="arun-gate gdas-card"
      data-state={actionSheet.state}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={stateId}
      onKeyDown={handleKeyDown}
    >
      <div className="arun-gate-h">
        <GitIcon size={13} /> {t("gitDelivery.title")}
      </div>
      <div className="arun-gate-t" id={titleId}>
        {actionSheet.actionKind} · {actionSheet.actionId}
      </div>
      {/* The state is named in text — never conveyed by colour alone (AC5). */}
      <p className="gdas-state" id={stateId} data-testid="gdas-state">
        {t("gitDelivery.state.label", { state: stateLabel(actionSheet.state, t) })}
      </p>
      {/* Live region announces state transitions to assistive tech (AC5), mirroring RunSummaryCard. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="gdas-live">
        {t("gitDelivery.state.announcement", {
          id: actionSheet.actionId,
          state: stateLabel(actionSheet.state, t).toLowerCase(),
        })}
      </p>

      <ApprovalSection
        approval={actionSheet.approval}
        policyExplanation={actionSheet.policyExplanation}
        t={t}
      />
      <PreviewSection preview={actionSheet.preview} t={t} />
      {blocked && actionSheet.blocked !== undefined ? (
        <BlockedSection blocked={actionSheet.blocked} t={t} />
      ) : null}
      <RecoverySection recovery={actionSheet.recovery} t={t} />

      <div className="arun-gate-btns gdas-actions">
        {onReject !== undefined ? (
          <button type="button" className="arun-btn ghost" onClick={onReject}>
            {t("gitDelivery.action.reject")}
          </button>
        ) : null}
        {waiting ? (
          <button
            type="button"
            className="arun-btn primary"
            onClick={onApprove}
            data-testid="gdas-approve"
          >
            {t("gitDelivery.action.approve")}
          </button>
        ) : (
          <button
            type="button"
            className="arun-btn primary"
            onClick={onConfirm}
            disabled={!ready}
            data-testid="gdas-confirm"
          >
            {t("gitDelivery.action.confirm")}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── DI seam container (mirrors QiRunCard.fetchDetailImpl) ─────────────────────────────────

export interface GitDeliveryActionSheetCardProps {
  /** When provided, the sheet renders directly (pure/testable) and no fetch occurs. */
  readonly actionSheet?: GitDeliveryActionSheet | undefined;
  /** Seam for tests; defaults to the real BFF client. Used only when `request` is provided. */
  readonly fetchImpl?: typeof fetchGitDeliveryActionSheet;
  /** The content-free backend facts to POST when fetching on mount. */
  readonly request?: Parameters<typeof fetchGitDeliveryActionSheet>[0] | undefined;
  readonly onApprove?: (() => void) | undefined;
  readonly onConfirm?: (() => void) | undefined;
  readonly onReject?: (() => void) | undefined;
}

export function GitDeliveryActionSheetCard({
  actionSheet,
  fetchImpl = fetchGitDeliveryActionSheet,
  request,
  onApprove,
  onConfirm,
  onReject,
}: GitDeliveryActionSheetCardProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [fetched, setFetched] = useState<GitDeliveryActionSheet | null>(null);
  const [loading, setLoading] = useState<boolean>(
    actionSheet === undefined && request !== undefined,
  );
  const [error, setError] = useState<string | null>(null);
  // Drop stale responses when the request changes mid-flight (request-of-record guard).
  const seqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (request === undefined) return;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchImpl(request);
      if (seqRef.current === seq) setFetched(res);
    } catch (err) {
      if (seqRef.current === seq) setError(formatError(err, t));
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [fetchImpl, request, t]);

  useEffect(() => {
    // Only fetch when no sheet is supplied directly and a request is present.
    if (actionSheet === undefined && request !== undefined) {
      void load();
    }
  }, [actionSheet, request, load]);

  // A directly supplied sheet always wins — pure render path for tests and embedding callers.
  const sheet = actionSheet ?? fetched;

  if (actionSheet === undefined && request === undefined) {
    return (
      <div className="gdas-empty" data-testid="gdas-empty">
        <p>{t("gitDelivery.empty")}</p>
      </div>
    );
  }

  if (sheet === null) {
    if (error !== null) {
      return (
        <div role="alert" aria-live="assertive" className="lk-alert" data-testid="gdas-error">
          {error}
          <button type="button" className="lk-alert-retry" onClick={() => void load()}>
            {t("gitDelivery.action.retry")}
          </button>
        </div>
      );
    }
    return (
      <div className="gdas-loading" data-testid="gdas-loading" aria-busy={loading}>
        <p className="sr-only" role="status" aria-live="polite">
          {t("gitDelivery.loading.announcement")}
        </p>
        <span aria-hidden="true">{t("gitDelivery.loading.visible")}</span>
      </div>
    );
  }

  return (
    <GitDeliveryActionSheetView
      actionSheet={sheet}
      onApprove={onApprove}
      onConfirm={onConfirm}
      onReject={onReject}
    />
  );
}
