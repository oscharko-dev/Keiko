// Pure projection: content-free kernel facts → UI-safe GitDeliveryActionSheet (Issue #473, Epic #470).
//
// This module is a PURE function of (resolvedInputs, worktreeSnapshot, trusted policy packs, approval
// shape, provider state, providerReady). It runs the kernel preflight (keiko-tools) and the policy
// evaluator (keiko-contracts), maps their content-free outputs into the action-sheet's typed
// expected-blocker and recovery-hint vocabularies, and hands the assembled facts to the contract's
// buildGitDeliveryActionSheet. No IO, no clock, no randomness, no request access — the caller (the
// route handler) gathers the facts and supplies the actionId and trusted packs.
//
// AUTHORITY (AC1): the policy decision, approval necessity, and required approvers are derived ONLY
// from evaluateGitPolicy over the server's TRUSTED packs. The approval payload is consumed for its
// SHAPE alone (whether a granted approval is attached); it never asserts the policy decision.
//
// Content-free: every value produced here is a count, flag, branch name, or typed/closed-vocabulary
// code. Never diff content, file paths, secrets, command strings, or raw subprocess output.

import {
  buildGitDeliveryActionSheet,
  gitDeliverySuggestedRecoveryStrategy,
  type GitDeliveryActionKind,
  type GitDeliveryActionSheet,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryBranchProtection,
  type GitDeliveryChecksState,
  type GitDeliveryExpectedBlocker,
  type GitDeliveryMergeReadiness,
  type GitDeliveryOrgPolicyPack,
  type GitDeliveryPolicyDecision,
  type GitDeliveryProviderCapability,
  type GitDeliveryPullRequestState,
  type GitDeliveryRecoveryActionHint,
  type GitDeliveryRecoveryHint,
  type GitDeliveryRemediationClass,
  type GitDeliveryRepoPolicyPack,
  type GitDeliveryResolvedInputs,
  evaluateGitPolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPreflight,
  type GitPreflightFinding,
  type GitPreflightFindingCode,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";

// ─── Provider state bundle (optional, content-free) ─────────────────────────────────

export interface GitDeliveryProviderStateFacts {
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly mergeReadiness?: GitDeliveryMergeReadiness | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
}

export interface GitDeliveryTrustedPolicyPacks {
  readonly orgPack?: GitDeliveryOrgPolicyPack | undefined;
  readonly repoPack?: GitDeliveryRepoPolicyPack | undefined;
}

export interface BuildActionSheetFacts {
  readonly actionId: string;
  readonly resolvedInputs: GitDeliveryResolvedInputs;
  readonly worktreeSnapshot: GitWorktreeSnapshot;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
  readonly policyPacks: GitDeliveryTrustedPolicyPacks;
  readonly activeProviderCapabilities: readonly GitDeliveryProviderCapability[];
  readonly providerState: GitDeliveryProviderStateFacts;
  readonly providerReady: boolean;
  // The server clock (epoch ms). Used ONLY to demote an expired granted approval to not-attached so the
  // sheet honestly shows "waiting-for-approval" — parity with the #472 kernel's approvalIsValid. The
  // contract leaf is clockless; expiry judgement therefore lives here, not in the contract.
  readonly nowMs: number;
}

// Demotes an expired granted approval to "not attached" so the action-sheet projection never shows an
// expired grant as satisfied/ready. The #472 execution kernel re-validates the token and expiry
// independently before any mutation; this is the preview-time mirror of that check.
function effectiveApproval(
  approval: GitDeliveryApprovalRequirement,
  nowMs: number,
): GitDeliveryApprovalRequirement {
  if (approval.required && approval.expiresAtMs !== undefined && approval.expiresAtMs <= nowMs) {
    return { required: false };
  }
  return approval;
}

// ─── Target-branch derivation (for policy evaluation) ───────────────────────────────
// The affected branch name the policy evaluator matches branch-pattern rules against. Mirrors the
// contract's affectedBranchOf but is local so this module owns its own policy-context derivation.

function targetBranchName(inputs: GitDeliveryResolvedInputs): string | undefined {
  switch (inputs.kind) {
    case "branch-create":
      return inputs.branchName;
    case "push":
      return inputs.sourceBranchName;
    case "pr-create":
    case "pr-update":
      return inputs.headBranchName;
    default:
      return undefined;
  }
}

// ─── Expected-blocker mapping (AC2/AC3) ─────────────────────────────────────────────

function preflightBlocker(finding: GitPreflightFinding): GitDeliveryExpectedBlocker {
  return {
    source: "preflight",
    severity: finding.severity,
    remediation: finding.remediation,
    reasonCode: finding.code,
  };
}

function policyBlocker(
  decision: GitDeliveryPolicyDecision,
): GitDeliveryExpectedBlocker | undefined {
  if (decision.outcome !== "blocked") {
    return undefined;
  }
  return {
    source: "policy",
    severity: "blocking",
    remediation: "user-actionable",
    reasonCode: decision.reason,
  };
}

const PROVIDER_BLOCKER_KINDS: readonly GitDeliveryActionKind[] = [
  "merge",
  "pr-create",
  "pr-update",
];

function providerBlocker(
  inputs: GitDeliveryResolvedInputs,
  mergeReadiness: GitDeliveryMergeReadiness | undefined,
): GitDeliveryExpectedBlocker | undefined {
  if (!PROVIDER_BLOCKER_KINDS.includes(inputs.kind)) {
    return undefined;
  }
  if (mergeReadiness?.ready !== false || mergeReadiness.blockingReason === undefined) {
    return undefined;
  }
  return {
    source: "provider",
    severity: "advisory",
    remediation: "user-actionable",
    reasonCode: mergeReadiness.blockingReason,
  };
}

function collectExpectedBlockers(
  findings: readonly GitPreflightFinding[],
  decision: GitDeliveryPolicyDecision,
  inputs: GitDeliveryResolvedInputs,
  mergeReadiness: GitDeliveryMergeReadiness | undefined,
): readonly GitDeliveryExpectedBlocker[] {
  const blockers: GitDeliveryExpectedBlocker[] = findings.map(preflightBlocker);
  const policy = policyBlocker(decision);
  if (policy !== undefined) {
    blockers.push(policy);
  }
  const provider = providerBlocker(inputs, mergeReadiness);
  if (provider !== undefined) {
    blockers.push(provider);
  }
  return blockers;
}

// ─── Recovery-hint mapping (AC4 — common failure classes, same surface) ─────────────
// A deterministic, exhaustive table from each preflight finding code to a recovery action hint. The
// "recover-via-strategy" hints are produced separately so they can carry a suggestedRecoveryStrategy.

const STRATEGY_RECOVERY_CODES: ReadonlySet<GitPreflightFindingCode> = new Set([
  "dirty-worktree-impacts-recovery",
  "recovery-target-unset",
]);

const FINDING_RECOVERY_HINT: Readonly<
  Record<GitPreflightFindingCode, GitDeliveryRecoveryActionHint>
> = {
  "detached-head": "configure-upstream",
  "branch-already-exists": "adjust-policy-target",
  "base-branch-missing": "adjust-policy-target",
  "switch-target-missing": "adjust-policy-target",
  "no-changes-to-stage": "stage-changes",
  "nothing-staged-to-unstage": "stage-changes",
  "nothing-staged-to-commit": "stage-changes",
  "untracked-files-impacted": "stage-changes",
  "no-upstream-configured": "configure-upstream",
  "nothing-to-push": "retry",
  "remote-alias-missing": "configure-upstream",
  "remote-unreachable": "retry",
  "operation-in-progress": "abort-in-progress-operation",
  "no-operation-to-abort": "retry",
  "recovery-target-unset": "recover-via-strategy",
  "dirty-worktree-impacts-recovery": "recover-via-strategy",
};

function worktreeIsDirty(snapshot: GitWorktreeSnapshot): boolean {
  return (
    snapshot.stagedFileCount > 0 ||
    snapshot.unstagedFileCount > 0 ||
    snapshot.untrackedFileCount > 0
  );
}

function recoveryHintForFinding(
  finding: GitPreflightFinding,
  inputs: GitDeliveryResolvedInputs,
  snapshot: GitWorktreeSnapshot,
): GitDeliveryRecoveryHint {
  if (STRATEGY_RECOVERY_CODES.has(finding.code)) {
    return {
      actionHint: "recover-via-strategy",
      remediation: finding.remediation,
      suggestedRecoveryStrategy: gitDeliverySuggestedRecoveryStrategy(
        inputs.kind,
        worktreeIsDirty(snapshot),
      ),
    };
  }
  return { actionHint: FINDING_RECOVERY_HINT[finding.code], remediation: finding.remediation };
}

function policyRecoveryHint(
  decision: GitDeliveryPolicyDecision,
): GitDeliveryRecoveryHint | undefined {
  if (decision.outcome === "approval-gated") {
    return { actionHint: "request-approval", remediation: "user-actionable" };
  }
  if (decision.outcome === "blocked") {
    const actionHint: GitDeliveryRecoveryActionHint =
      decision.reason === "approval-expired" ? "request-approval" : "adjust-policy-target";
    return { actionHint, remediation: "user-actionable" };
  }
  return undefined;
}

// De-duplicates recovery hints on a stable signature (action + strategy) so the same class of fix is
// surfaced once even when several findings map to it. First occurrence wins (order-preserving).
function dedupeRecoveryHints(
  hints: readonly GitDeliveryRecoveryHint[],
): readonly GitDeliveryRecoveryHint[] {
  const seen = new Set<string>();
  const out: GitDeliveryRecoveryHint[] = [];
  for (const hint of hints) {
    const signature = `${hint.actionHint}:${hint.suggestedRecoveryStrategy ?? ""}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      out.push(hint);
    }
  }
  return out;
}

function buildRecoveryHints(
  findings: readonly GitPreflightFinding[],
  decision: GitDeliveryPolicyDecision,
  inputs: GitDeliveryResolvedInputs,
  snapshot: GitWorktreeSnapshot,
  providerReady: boolean,
): readonly GitDeliveryRecoveryHint[] {
  const hints: GitDeliveryRecoveryHint[] = findings.map((finding) =>
    recoveryHintForFinding(finding, inputs, snapshot),
  );
  const policy = policyRecoveryHint(decision);
  if (policy !== undefined) {
    hints.push(policy);
  }
  if (!providerReady) {
    hints.push({ actionHint: "wait-for-provider", remediation: "internal" });
  }
  return dedupeRecoveryHints(hints);
}

// A defensive coercion that drops `undefined` provider members so exactOptionalPropertyTypes is not
// violated when spreading the optional provider state into the contract assembler input.
interface MutableProviderState {
  pullRequest?: GitDeliveryPullRequestState;
  mergeReadiness?: GitDeliveryMergeReadiness;
  branchProtection?: GitDeliveryBranchProtection;
  checks?: GitDeliveryChecksState;
}

function definedProviderState(state: GitDeliveryProviderStateFacts): MutableProviderState {
  const out: MutableProviderState = {};
  if (state.pullRequest !== undefined) out.pullRequest = state.pullRequest;
  if (state.mergeReadiness !== undefined) out.mergeReadiness = state.mergeReadiness;
  if (state.branchProtection !== undefined) out.branchProtection = state.branchProtection;
  if (state.checks !== undefined) out.checks = state.checks;
  return out;
}

/**
 * The pure projection. Runs preflight + policy over the supplied content-free facts and assembles the
 * UI-safe action sheet. Deterministic: identical facts always yield an identical sheet.
 */
export function buildActionSheetFromFacts(facts: BuildActionSheetFacts): GitDeliveryActionSheet {
  const { resolvedInputs, worktreeSnapshot, providerState } = facts;
  const preflight = evaluateGitPreflight(resolvedInputs, worktreeSnapshot);
  const policyDecision = evaluateGitPolicy(facts.policyPacks.orgPack, facts.policyPacks.repoPack, {
    actionKind: resolvedInputs.kind,
    targetBranchName: targetBranchName(resolvedInputs),
    activeProviderCapabilities: facts.activeProviderCapabilities,
  });
  const expectedBlockers = collectExpectedBlockers(
    preflight.findings,
    policyDecision,
    resolvedInputs,
    providerState.mergeReadiness,
  );
  const recovery = buildRecoveryHints(
    preflight.findings,
    policyDecision,
    resolvedInputs,
    worktreeSnapshot,
    facts.providerReady,
  );
  return buildGitDeliveryActionSheet({
    actionId: facts.actionId,
    resolvedInputs,
    policyDecision,
    approvalRequirement: effectiveApproval(facts.approvalRequirement, facts.nowMs),
    providerReady: facts.providerReady,
    expectedBlockers,
    recovery,
    ...definedProviderState(providerState),
  });
}

// Re-export the remediation-class type so the route handler's tests can reference the projection's
// vocabulary without reaching into the contracts barrel a second time.
export type { GitDeliveryRemediationClass };
