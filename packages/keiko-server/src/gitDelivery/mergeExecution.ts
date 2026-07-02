// Governed merge execution core for the #478 merge routes (Epic #470, ADR-0065).
//
// The merge preview + execute routes share ONE path: resolve and authorize the project workspace, read
// the provider's content-free merge-readiness facts, and (for execute) drive the #478 merge gateway
// `runGitMerge` (the SEPARATE merge-orchestration authority — preflight + policy + final-approval gates +
// the readiness gate, executing through a narrow `gh api` adapter with a dedicated merge-only allowlist)
// and append a content-free evidence record through the #474 ledger for EVERY terminal outcome (allowed
// and blocked alike — AC4). No second orchestrator, no generic shell, no widening of the local mutation,
// publish, or PR allowlists. The Node `gh api` effect is injected via seams so route tests run
// deterministically against a fake.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  deriveEligibleMergeStrategies,
  evaluateGitPolicy,
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  gitMergeBlockerActionHintFor,
  gitMergeReadinessFor,
  gitMergeRecommendationFor,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryMergeStrategyHint,
  type GitDeliveryRepoPolicyPack,
  type GitDeliveryRiskClass,
  type GitMergeReadinessBlocker,
  type GitMergeReadinessSummary,
  type GitMergeStrategyPolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitMergeEffectivePolicy,
  runGitMerge,
  type GitMergeAdapter,
  type GitMergeCommand,
  type GitMergeLifecycleResult,
  type GitMergeProviderReadiness,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import { createNodeGitMergeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { UiHandlerDeps } from "../deps.js";
import type { GitDeliveryApprovalStore } from "./approvalStore.js";
import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import {
  defaultGitDeliveryActionId,
  gitDeliveryMutationResponse,
  persistGitDeliveryEvidence,
  readWorktreeSnapshotFor,
  type GitDeliveryMutationResponseBody,
} from "./execution.js";

// Default trusted merge policy: merge is APPROVAL-GATED — the explicit final, high-risk confirmation a
// merge requires (AC1). No approval token ⇒ approval-required; every other action kind is fail-closed via
// the blocked defaultRule. Base-branch and strategy enforcement live in the readiness layer (where merge
// prerequisites belong), not in this authorization pack. Applies only when governed git delivery is
// ENABLED and no stricter pack is configured; still EVALUATED every time. A deployment may override with a
// pack naming specific requiredApprovers.
export const KEIKO_DEFAULT_MERGE_POLICY_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "keiko-merge-default",
  rules: [{ actionKind: "merge", decision: "approval-gated", requiredApprovers: [] }],
  defaultRule: { decision: "blocked" },
};

export interface GitDeliveryMergeSeams {
  readonly mergeAdapterFactory?: ((workspace: WorkspaceInfo) => GitMergeAdapter) | undefined;
  readonly snapshotReader?:
    ((workspace: WorkspaceInfo) => Promise<GitWorktreeSnapshot>) | undefined;
  readonly policyPacks?: GitDeliveryTrustedPolicyPacks | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly strategyPolicy?: GitMergeStrategyPolicy | undefined;
  readonly now?: (() => number) | undefined;
  readonly newActionId?: (() => string) | undefined;
}

function mergeAdapterFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryMergeSeams,
  now: () => number,
): GitMergeAdapter {
  if (seams.mergeAdapterFactory !== undefined) return seams.mergeAdapterFactory(workspace);
  return createNodeGitMergeAdapter({ workspace, processEnv: process.env, now });
}

// Reads the provider's content-free merge-readiness facts. Never throws: a thrown read becomes a
// provider-error readiness so callers fail closed.
export async function readMergeProviderReadiness(
  command: GitMergeCommand,
  workspace: WorkspaceInfo,
  seams: GitDeliveryMergeSeams,
  now: () => number,
): Promise<GitMergeProviderReadiness> {
  const adapter = mergeAdapterFor(workspace, seams, now);
  try {
    return await adapter.readMergeReadiness({
      ownerAndRepo: command.ownerAndRepo,
      prExternalId: command.prExternalId,
    });
  } catch {
    return { providerCapableStrategies: [], providerError: true };
  }
}

/**
 * Runs ONE governed merge end-to-end: live snapshot → merge gateway (preflight + policy + approval +
 * readiness gate + execute) → evidence. Returns the gateway lifecycle result; the caller projects it into
 * a content-free HTTP body. Evidence is appended best-effort BEFORE the caller responds, for allowed AND
 * blocked alike.
 */
export async function executeGovernedMerge(
  command: GitMergeCommand,
  approval: GitDeliveryApprovalRequirement,
  workspace: WorkspaceInfo,
  deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor">,
  seams: GitDeliveryMergeSeams,
): Promise<GitMergeLifecycleResult> {
  const now = seams.now ?? Date.now;
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
  const adapter = mergeAdapterFor(workspace, seams, now);
  const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_MERGE_POLICY_PACK };
  const newActionId =
    seams.newActionId ?? ((): string => defaultGitDeliveryActionId(command, now()));
  const result = await runGitMerge(
    { command, approval },
    {
      adapter,
      snapshot,
      ...(packs.orgPack !== undefined ? { orgPolicyPack: packs.orgPack } : {}),
      ...(packs.repoPack !== undefined ? { repoPolicyPack: packs.repoPack } : {}),
      ...(seams.strategyPolicy !== undefined ? { strategyPolicy: seams.strategyPolicy } : {}),
      now,
      newActionId,
    },
  );
  persistGitDeliveryEvidence(deps, result.lifecycle, snapshot, workspace.root, now);
  return result;
}

// ─── Read-only preview projection ──────────────────────────────────────────────────────────────────

// A content-free, per-blocker view that carries the precise blocker code AND its recovery information
// (severity, remediation class, and a recovery action hint where one fits) — so the UI can render
// recovery guidance for pre-merge readiness blocks, not just for provider-time rejections (AC3).
export interface GitDeliveryMergeBlockerView {
  readonly code: string;
  readonly severity: string;
  readonly remediation: string;
  readonly actionHint?: string;
}

function mergeBlockerView(blocker: GitMergeReadinessBlocker): GitDeliveryMergeBlockerView {
  const actionHint = gitMergeBlockerActionHintFor(blocker.code);
  return {
    code: blocker.code,
    severity: blocker.severity,
    remediation: blocker.remediation,
    ...(actionHint !== undefined ? { actionHint } : {}),
  };
}

function mergeBlockerViews(
  summary: GitMergeReadinessSummary,
): readonly GitDeliveryMergeBlockerView[] {
  return summary.blockers.map(mergeBlockerView);
}

export interface GitDeliveryMergeReadinessBody {
  readonly mergeable: boolean;
  readonly blockers: readonly GitDeliveryMergeBlockerView[];
}

export interface GitDeliveryMergePreviewBody {
  readonly schemaVersion: "1";
  readonly actionKind: "merge";
  readonly baseBranchName: string;
  readonly headBranchName: string;
  readonly prExternalId: string;
  readonly riskClass: GitDeliveryRiskClass;
  readonly riskSeverity: number;
  readonly requestedStrategy: GitDeliveryMergeStrategyHint;
  // The strategies the user may choose from (policy ∩ provider capability) — never a hard-coded UI
  // default (AC2).
  readonly eligibleStrategies: readonly GitDeliveryMergeStrategyHint[];
  readonly selectedDefaultStrategy?: GitDeliveryMergeStrategyHint;
  readonly requestedStrategyEligible: boolean;
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
  readonly requiresApproval: boolean;
  readonly readiness: GitDeliveryMergeReadinessBody;
  readonly recommendation: string;
}

interface MergePreviewParts {
  readonly effectiveOutcome: string;
  readonly blockReason?: string;
  readonly requiresApproval: boolean;
  readonly eligibleStrategies: readonly GitDeliveryMergeStrategyHint[];
  readonly selectedDefaultStrategy?: GitDeliveryMergeStrategyHint;
  readonly requestedStrategyEligible: boolean;
  readonly readiness: GitMergeReadinessSummary;
  readonly recommendation: string;
}

function deriveMergePreviewParts(
  command: GitMergeCommand,
  provider: GitMergeProviderReadiness,
  packs: GitDeliveryTrustedPolicyPacks,
  strategyPolicy: GitMergeStrategyPolicy,
): MergePreviewParts {
  const decision = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
    actionKind: "merge",
    targetBranchName: command.baseBranchName,
    activeProviderCapabilities: [],
  });
  const effective = evaluateGitMergeEffectivePolicy(decision, command.baseBranchName, []);
  const eligibility = deriveEligibleMergeStrategies(
    command.mergeStrategy,
    strategyPolicy,
    provider.providerCapableStrategies,
  );
  const readiness = gitMergeReadinessFor({
    ...(provider.pullRequest !== undefined ? { pullRequest: provider.pullRequest } : {}),
    ...(provider.checks !== undefined ? { checks: provider.checks } : {}),
    ...(provider.branchProtection !== undefined
      ? { branchProtection: provider.branchProtection }
      : {}),
    strategyEligible: eligibility.requestedEligible,
    ...(provider.providerError === true ? { providerError: true } : {}),
  });
  const requiresApproval = effective.outcome === "approval-gated";
  return {
    effectiveOutcome: effective.outcome,
    ...(effective.blockReason !== undefined ? { blockReason: effective.blockReason } : {}),
    requiresApproval,
    eligibleStrategies: eligibility.eligible,
    ...(eligibility.selectedDefault !== undefined
      ? { selectedDefaultStrategy: eligibility.selectedDefault }
      : {}),
    requestedStrategyEligible: eligibility.requestedEligible,
    readiness,
    // The preview has no approval token, so approvalSatisfied is false.
    recommendation: gitMergeRecommendationFor(readiness, {
      requiresApproval,
      approvalSatisfied: false,
    }),
  };
}

export function buildGitDeliveryMergePreview(
  command: GitMergeCommand,
  provider: GitMergeProviderReadiness,
  packs: GitDeliveryTrustedPolicyPacks,
  strategyPolicy: GitMergeStrategyPolicy,
): GitDeliveryMergePreviewBody {
  const parts = deriveMergePreviewParts(command, provider, packs, strategyPolicy);
  const riskClass: GitDeliveryRiskClass = "protected-or-merge";
  return {
    schemaVersion: "1",
    actionKind: "merge",
    baseBranchName: command.baseBranchName,
    headBranchName: command.headBranchName,
    prExternalId: command.prExternalId,
    riskClass,
    riskSeverity: GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass],
    requestedStrategy: command.mergeStrategy,
    eligibleStrategies: parts.eligibleStrategies,
    ...(parts.selectedDefaultStrategy !== undefined
      ? { selectedDefaultStrategy: parts.selectedDefaultStrategy }
      : {}),
    requestedStrategyEligible: parts.requestedStrategyEligible,
    policyOutcome: parts.effectiveOutcome,
    ...(parts.blockReason !== undefined ? { policyBlockReason: parts.blockReason } : {}),
    requiresApproval: parts.requiresApproval,
    readiness: {
      mergeable: parts.readiness.mergeable,
      blockers: mergeBlockerViews(parts.readiness),
    },
    recommendation: parts.recommendation,
  };
}

// ─── Execute response projection ─────────────────────────────────────────────────────────────────

export interface GitDeliveryMergeExecuteResponseBody extends GitDeliveryMutationResponseBody {
  // Present only when an executed merge was rejected by the provider: the precise, content-free rejection
  // reason and the reused recovery disposition / action hint (AC3/AC4).
  readonly mergeRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
  // The merge-readiness summary read from the provider (present whenever the readiness gate was reached).
  // The per-blocker views carry the recovery information (remediation + action hint) for a readiness
  // block, mirroring the rejection recovery fields for a provider-time failure (AC3).
  readonly mergeable?: boolean;
  readonly readinessBlockers?: readonly GitDeliveryMergeBlockerView[];
  readonly merged?: boolean;
  readonly branchDeleted?: boolean;
}

export function gitDeliveryMergeExecuteResponse(
  result: GitMergeLifecycleResult,
): GitDeliveryMergeExecuteResponseBody {
  const base = gitDeliveryMutationResponse(result.lifecycle);
  const withReadiness: GitDeliveryMergeExecuteResponseBody = {
    ...base,
    ...(result.readiness !== undefined
      ? {
          mergeable: result.readiness.mergeable,
          readinessBlockers: mergeBlockerViews(result.readiness),
        }
      : {}),
    ...(result.merged !== undefined ? { merged: result.merged } : {}),
    ...(result.branchDeleted !== undefined ? { branchDeleted: result.branchDeleted } : {}),
  };
  if (result.rejection === undefined) {
    return withReadiness;
  }
  return {
    ...withReadiness,
    mergeRejectionReason: result.rejection.reason,
    recoveryDisposition: result.rejection.disposition,
    ...(result.rejection.actionHint !== undefined
      ? { recoveryActionHint: result.rejection.actionHint }
      : {}),
  };
}
