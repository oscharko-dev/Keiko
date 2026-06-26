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
import { Icons } from "../../Icons";

// ─── Display label maps (typed codes → human text; never colour-alone) ─────────────────

const STATE_LABEL: Readonly<Record<GitDeliveryActionSheetState, string>> = {
  "ready-to-execute": "Ready to execute",
  "waiting-for-approval": "Waiting for approval",
  blocked: "Blocked",
};

const NECESSITY_LABEL: Readonly<Record<GitDeliveryApprovalNecessity, string>> = {
  "not-required": "Optional",
  required: "Mandatory",
  impossible: "Impossible",
};

const RISK_CLASS_LABEL: Readonly<Record<GitDeliveryRiskClass, string>> = {
  "local-mutation": "Local mutation",
  publish: "Publish",
  "protected-or-merge": "Protected or merge",
  "recovery-or-rewrite": "Recovery or rewrite",
};

const BLOCKED_CAUSE_LABEL: Readonly<Record<GitDeliveryBlockedCause, string>> = {
  policy: "Blocked by policy",
  preflight: "Blocked by a preflight check",
  "provider-not-ready": "Provider not ready",
};

const BLOCKER_SOURCE_LABEL: Readonly<Record<GitDeliveryBlockerSource, string>> = {
  preflight: "Preflight",
  policy: "Policy",
  provider: "Provider",
};

const BLOCKER_SEVERITY_LABEL: Readonly<Record<GitDeliveryBlockerSeverity, string>> = {
  blocking: "Blocking",
  advisory: "Advisory",
};

const REMEDIATION_LABEL: Readonly<Record<GitDeliveryRemediationClass, string>> = {
  "user-actionable": "You can fix this",
  internal: "Handled internally",
};

const BLOCK_REASON_LABEL: Readonly<Record<GitDeliveryBlockReason, string>> = {
  "policy-pack-blocked": "Denied by the policy pack",
  "protected-branch": "Target is a protected branch",
  "provider-capability-absent": "Required provider capability is absent",
  "approval-expired": "The granted approval has expired",
  "risk-class-ceiling": "Exceeds the allowed risk-class ceiling",
  "no-applicable-rule": "No applicable policy rule (fail-closed)",
};

const POLICY_DECISION_LABEL: Readonly<Record<GitDeliveryPolicyExplanation["decision"], string>> = {
  allowed: "Allowed",
  blocked: "Blocked",
  "approval-gated": "Approval required",
  constrained: "Allowed within constraints",
};

const RECOVERY_HINT_LABEL: Readonly<Record<GitDeliveryRecoveryActionHint, string>> = {
  retry: "Retry the action",
  "stage-changes": "Stage your changes",
  "configure-upstream": "Configure the upstream branch",
  "resolve-conflicts": "Resolve the conflicts",
  "abort-in-progress-operation": "Abort the in-progress operation",
  "request-approval": "Request approval",
  "adjust-policy-target": "Adjust the policy target",
  "recover-via-strategy": "Recover via a governed strategy",
  "wait-for-provider": "Wait for the provider",
};

const RECOVERY_STRATEGY_LABEL: Readonly<Record<GitDeliveryRecoveryStrategyHint, string>> = {
  "soft-reset": "soft reset",
  "mixed-reset": "mixed reset",
  "stash-and-reset": "stash and reset",
  "restore-index": "restore index",
};

function constraintLabel(constraint: GitDeliveryConstraint): string {
  switch (constraint.kind) {
    case "branch-pattern":
      return `Branch pattern: ${constraint.patterns
        .map((p) => `${p.matchKind} "${p.value}"`)
        .join(", ")}`;
    case "provider-capability":
      return `Requires provider capability: ${constraint.capability}`;
    case "risk-class-ceiling":
      return `Risk-class ceiling: ${RISK_CLASS_LABEL[constraint.maxRiskClass]}`;
    default: {
      // Exhaustive: a new GitDeliveryConstraint kind must update this switch (compile-time error).
      const unreachable: never = constraint;
      return unreachable;
    }
  }
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

// ─── Preview manifest (AC2) ────────────────────────────────────────────────────────────

function PreviewSection({ preview }: { readonly preview: GitDeliveryPreviewManifest }): ReactNode {
  const remoteImpact: readonly string[] = [
    preview.touchesRemote ? "Touches the remote" : "Local only",
    ...(preview.wouldCreateRemoteBranch ? ["Would create a remote branch"] : []),
    ...(preview.wouldForcePublish ? ["Would force-publish"] : []),
    ...(preview.wouldTriggerChecks ? ["Would trigger checks"] : []),
  ];
  return (
    <section className="gdas-section" aria-label="Action preview">
      <h4 className="gdas-section-title">Preview</h4>
      <dl className="gdas-preview">
        <div className="gdas-kv">
          <dt>Action</dt>
          <dd>{preview.actionKind}</dd>
        </div>
        <div className="gdas-kv">
          <dt>Risk</dt>
          <dd>
            {RISK_CLASS_LABEL[preview.riskClass]} (severity {preview.riskSeverity.toString()})
          </dd>
        </div>
        {preview.affectedBranchName !== undefined ? (
          <div className="gdas-kv">
            <dt>Affected branch</dt>
            <dd className="gdas-mono">{preview.affectedBranchName}</dd>
          </div>
        ) : null}
        {preview.baseBranchName !== undefined ? (
          <div className="gdas-kv">
            <dt>Base branch</dt>
            <dd className="gdas-mono">{preview.baseBranchName}</dd>
          </div>
        ) : null}
        {preview.remoteBranchName !== undefined ? (
          <div className="gdas-kv">
            <dt>Remote branch</dt>
            <dd className="gdas-mono">{preview.remoteBranchName}</dd>
          </div>
        ) : null}
        {preview.estimatedFileCount !== undefined ? (
          <div className="gdas-kv">
            <dt>Files affected</dt>
            <dd>{preview.estimatedFileCount.toString()}</dd>
          </div>
        ) : null}
        {preview.estimatedBytesDelta !== undefined ? (
          <div className="gdas-kv">
            <dt>Bytes delta</dt>
            <dd>{preview.estimatedBytesDelta.toString()}</dd>
          </div>
        ) : null}
        <div className="gdas-kv">
          <dt>Remote impact</dt>
          <dd>{remoteImpact.join(" · ")}</dd>
        </div>
      </dl>
      {preview.pullRequest !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-pr">
          Pull request: {preview.pullRequest.status}
          {preview.pullRequest.isDraft ? " (draft)" : ""} ·{" "}
          {preview.pullRequest.mergeReadiness.receivedApprovalCount.toString()} of{" "}
          {preview.pullRequest.mergeReadiness.requiredApprovalCount.toString()} approvals
        </p>
      ) : null}
      {preview.mergeReadiness !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-merge">
          Merge readiness: {preview.mergeReadiness.ready ? "Ready to merge" : "Not ready to merge"}
          {preview.mergeReadiness.blockingReason !== undefined
            ? ` (${preview.mergeReadiness.blockingReason})`
            : ""}{" "}
          · {preview.mergeReadiness.receivedApprovalCount.toString()} of{" "}
          {preview.mergeReadiness.requiredApprovalCount.toString()} approvals
        </p>
      ) : null}
      {preview.branchProtection !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-protection">
          Branch protection: {preview.branchProtection.requiredReviewCount.toString()} required
          review{preview.branchProtection.requiredReviewCount === 1 ? "" : "s"},{" "}
          {preview.branchProtection.requiredStatusCheckCount.toString()} required check
          {preview.branchProtection.requiredStatusCheckCount === 1 ? "" : "s"}
        </p>
      ) : null}
      {preview.checks !== undefined ? (
        <p className="gdas-preview-line" data-testid="gdas-preview-checks">
          Checks: {preview.checks.overallStatus} ({preview.checks.passing.toString()} passing,{" "}
          {preview.checks.failing.toString()} failing, {preview.checks.pending.toString()} pending
          of {preview.checks.total.toString()})
        </p>
      ) : null}
    </section>
  );
}

// ─── Approval + policy explanation (AC1) ─────────────────────────────────────────────────

function ApprovalSection({
  approval,
  policyExplanation,
}: {
  readonly approval: GitDeliveryApprovalSummary;
  readonly policyExplanation: GitDeliveryPolicyExplanation;
}): ReactNode {
  return (
    <section className="gdas-section" aria-label="Approval and policy">
      <h4 className="gdas-section-title">Approval</h4>
      <dl className="gdas-preview">
        <div className="gdas-kv">
          <dt>Approval</dt>
          <dd data-testid="gdas-necessity">
            {NECESSITY_LABEL[approval.necessity]}
            {approval.necessity === "required"
              ? approval.satisfied
                ? " · satisfied"
                : " · not yet satisfied"
              : ""}
          </dd>
        </div>
        <div className="gdas-kv">
          <dt>Policy decision</dt>
          <dd data-testid="gdas-policy-decision">
            {POLICY_DECISION_LABEL[policyExplanation.decision]}
          </dd>
        </div>
        {policyExplanation.blockReason !== undefined ? (
          <div className="gdas-kv">
            <dt>Reason</dt>
            <dd data-testid="gdas-block-reason">
              {BLOCK_REASON_LABEL[policyExplanation.blockReason]}
            </dd>
          </div>
        ) : null}
      </dl>
      {policyExplanation.requiredApprovers.length > 0 ? (
        <div className="gdas-approvers" data-testid="gdas-required-approvers">
          <span className="gdas-section-subtitle">Required approvers</span>
          <ul className="gdas-approver-list" aria-label="Required approvers">
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
          <span className="gdas-section-subtitle">Constraints</span>
          <ul className="gdas-constraint-list" aria-label="Policy constraints">
            {policyExplanation.constraints.map((constraint, index) => (
              <li key={`${constraint.kind}-${index.toString()}`}>{constraintLabel(constraint)}</li>
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
}: {
  readonly blockers: readonly GitDeliveryExpectedBlocker[];
  readonly label: string;
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
          aria-label={`${BLOCKER_SEVERITY_LABEL[blocker.severity]} ${BLOCKER_SOURCE_LABEL[blocker.source]} blocker: ${blocker.reasonCode}. ${REMEDIATION_LABEL[blocker.remediation]}.`}
        >
          <span className="gdas-blocker-badges" aria-hidden="true">
            <span className="gdas-badge gdas-badge-source">
              {BLOCKER_SOURCE_LABEL[blocker.source]}
            </span>
            <span className="gdas-badge" data-severity={blocker.severity}>
              {BLOCKER_SEVERITY_LABEL[blocker.severity]}
            </span>
          </span>
          <span className="gdas-mono gdas-blocker-code" aria-hidden="true">
            {blocker.reasonCode}
          </span>
          <span className="gdas-blocker-remediation" aria-hidden="true">
            {REMEDIATION_LABEL[blocker.remediation]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BlockedSection({ blocked }: { readonly blocked: GitDeliveryBlockedDetail }): ReactNode {
  return (
    <section className="gdas-section gdas-blocked" aria-label="Blocked details">
      <h4 className="gdas-section-title">Blocked</h4>
      <p className="gdas-blocked-cause" data-testid="gdas-blocked-cause">
        {BLOCKED_CAUSE_LABEL[blocked.cause]}
      </p>
      <ExpectedBlockerList blockers={blocked.expectedBlockers} label="Blocking conditions" />
    </section>
  );
}

// ─── Recovery hints (AC4 — in the same surface) ───────────────────────────────────────────

function RecoverySection({
  recovery,
}: {
  readonly recovery: readonly GitDeliveryRecoveryHint[];
}): ReactNode {
  if (recovery.length === 0) return null;
  return (
    <section className="gdas-section gdas-recovery" aria-label="Recovery hints">
      <h4 className="gdas-section-title">Recovery</h4>
      <ul className="gdas-recovery-list" aria-label="Recovery hints list">
        {recovery.map((hint, index) => {
          const strategy =
            hint.suggestedRecoveryStrategy !== undefined
              ? ` Suggested strategy: ${RECOVERY_STRATEGY_LABEL[hint.suggestedRecoveryStrategy]}.`
              : "";
          return (
            <li
              key={`${hint.actionHint}-${index.toString()}`}
              className="gdas-recovery-item"
              data-testid="gdas-recovery-item"
            >
              <span className="gdas-recovery-action">{RECOVERY_HINT_LABEL[hint.actionHint]}</span>
              <span className="gdas-recovery-remediation">
                {REMEDIATION_LABEL[hint.remediation]}
              </span>
              {hint.suggestedRecoveryStrategy !== undefined ? (
                <span className="gdas-recovery-strategy" data-testid="gdas-recovery-strategy">
                  Suggested strategy: {RECOVERY_STRATEGY_LABEL[hint.suggestedRecoveryStrategy]}
                </span>
              ) : null}
              {/* Carry the full hint (action + remediation + strategy) in one accessible string so
                  nothing relies on colour or layout alone. */}
              <span className="sr-only">
                {RECOVERY_HINT_LABEL[hint.actionHint]}. {REMEDIATION_LABEL[hint.remediation]}.
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
  const titleId = useId();
  const stateId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const waiting = actionSheet.state === "waiting-for-approval";
  const blocked = actionSheet.state === "blocked";
  const ready = actionSheet.state === "ready-to-execute";

  // Focus management (AC5): when the surface escalates to a waiting-for-approval decision the
  // Approve affordance receives focus; otherwise the confirm/execute affordance does. Mirrors
  // AgentGateCard's focus-on-mount.
  const approveRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (waiting) {
      approveRef.current?.focus();
    } else if (blocked) {
      dialogRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
  }, [blocked, waiting]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && onReject !== undefined) {
      event.stopPropagation();
      onReject();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-reject on the alertdialog container mirrors the Reject button for keyboard users, exactly like AgentGateCard
    <div
      className="arun-gate gdas-card"
      data-state={actionSheet.state}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={stateId}
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="arun-gate-h">
        <Icons.git size={13} /> Governed Git delivery
      </div>
      <div className="arun-gate-t" id={titleId}>
        {actionSheet.actionKind} · {actionSheet.actionId}
      </div>
      {/* The state is named in text — never conveyed by colour alone (AC5). */}
      <p className="gdas-state" id={stateId} data-testid="gdas-state">
        State: {STATE_LABEL[actionSheet.state]}
      </p>
      {/* Live region announces state transitions to assistive tech (AC5), mirroring RunSummaryCard. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="gdas-live">
        {`Git delivery action ${actionSheet.actionId} is ${STATE_LABEL[
          actionSheet.state
        ].toLowerCase()}.`}
      </p>

      <ApprovalSection
        approval={actionSheet.approval}
        policyExplanation={actionSheet.policyExplanation}
      />
      <PreviewSection preview={actionSheet.preview} />
      {blocked && actionSheet.blocked !== undefined ? (
        <BlockedSection blocked={actionSheet.blocked} />
      ) : null}
      <RecoverySection recovery={actionSheet.recovery} />

      <div className="arun-gate-btns gdas-actions">
        {onReject !== undefined ? (
          <button type="button" className="arun-btn ghost" onClick={onReject}>
            Reject
          </button>
        ) : null}
        {waiting ? (
          <button
            type="button"
            className="arun-btn primary"
            onClick={onApprove}
            ref={approveRef}
            data-testid="gdas-approve"
          >
            Approve
          </button>
        ) : (
          <button
            type="button"
            className="arun-btn primary"
            onClick={onConfirm}
            ref={confirmRef}
            disabled={!ready}
            data-testid="gdas-confirm"
          >
            Confirm
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
      if (seqRef.current === seq) setError(formatError(err));
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [fetchImpl, request]);

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
        <p>No Git delivery action to review.</p>
      </div>
    );
  }

  if (sheet === null) {
    if (error !== null) {
      return (
        <div role="alert" aria-live="assertive" className="lk-alert" data-testid="gdas-error">
          {error}
          <button type="button" className="lk-alert-retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="gdas-loading" data-testid="gdas-loading" aria-busy={loading}>
        <p className="sr-only" role="status" aria-live="polite">
          Loading the Git delivery action sheet…
        </p>
        <span aria-hidden="true">Loading…</span>
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
