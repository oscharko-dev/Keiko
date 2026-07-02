// Governed GitHub pull request execution core for the #477 PR routes (Epic #470, ADR-0064).
//
// The PR preview + execute routes share ONE path: resolve and authorize the project workspace, build a
// TRUSTWORTHY snapshot from the live worktree, drive the #477 PR gateway `runGitPullRequest` (the
// SEPARATE PR-orchestration authority — preflight + policy + approval gates, executing through a narrow
// `gh api` adapter with a dedicated PR-only allowlist), and append a content-free evidence record
// through the #474 ledger for EVERY terminal outcome (allowed and blocked alike — AC5). No second
// orchestrator, no generic shell, no widening of the local mutation or read-only inspection allowlists.
// The Node `gh api` effect is injected via seams so route tests run deterministically against a fake.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  evaluateGitPolicy,
  gitPullRequestLabelSuggestionsFor,
  gitPullRequestLinkageSuggestionsFor,
  gitPullRequestReadinessFor,
  gitPullRequestRecommendationFor,
  synthesizePullRequestMetadata,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryRepoPolicyPack,
  type GitDeliveryRiskClass,
  type GitPrChangeType,
  type GitPullRequestChangeNarrative,
  type GitPullRequestMetadataDraft,
  type GitPullRequestReadinessSummary,
  type GitPullRequestRiskDigest,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPullRequestEffectivePolicy,
  runGitPullRequest,
  type GitPullRequestAdapter,
  type GitPullRequestCommand,
  type GitPullRequestLifecycleResult,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import { createNodeGitPullRequestAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
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

// Default trusted PR policy: PERMIT `pr-create` / `pr-update` whose BASE is a legitimate integration
// branch (dev, main, release/*, feat/*) and only within the protected-or-merge ceiling. A base outside
// this allow-list is blocked with `policy-pack-blocked`. Opening a PR TO a protected base is a governed,
// normal operation (unlike a direct push to one, which the #476 publish pack blocks). Per-target
// approval escalation is a deployment override (an `approval-gated` rule); the gateway supports it but
// the default keeps PR creation reviewable-by-default with merge-approval deferred to #478. Applies only
// when governed git delivery is ENABLED and no stricter pack is configured; still EVALUATED every time.
const PR_BASE_CONSTRAINTS = [
  { kind: "risk-class-ceiling", maxRiskClass: "protected-or-merge" },
  {
    kind: "branch-pattern",
    patterns: [
      { matchKind: "exact", value: "dev" },
      { matchKind: "exact", value: "main" },
      { matchKind: "prefix", value: "release/" },
      { matchKind: "prefix", value: "feat/" },
    ],
  },
] as const;

export const KEIKO_DEFAULT_PR_POLICY_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "keiko-pr-default",
  rules: [
    { actionKind: "pr-create", decision: "constrained", constraints: [...PR_BASE_CONSTRAINTS] },
    { actionKind: "pr-update", decision: "constrained", constraints: [...PR_BASE_CONSTRAINTS] },
  ],
  defaultRule: { decision: "blocked" },
};

export interface GitDeliveryPullRequestSeams {
  readonly prAdapterFactory?: ((workspace: WorkspaceInfo) => GitPullRequestAdapter) | undefined;
  readonly snapshotReader?:
    ((workspace: WorkspaceInfo) => Promise<GitWorktreeSnapshot>) | undefined;
  readonly policyPacks?: GitDeliveryTrustedPolicyPacks | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly now?: (() => number) | undefined;
  readonly newActionId?: (() => string) | undefined;
}

function prAdapterFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryPullRequestSeams,
  now: () => number,
): GitPullRequestAdapter {
  if (seams.prAdapterFactory !== undefined) return seams.prAdapterFactory(workspace);
  return createNodeGitPullRequestAdapter({ workspace, processEnv: process.env, now });
}

/**
 * Runs ONE governed PR operation end-to-end: live snapshot → PR gateway (preflight + policy + approval +
 * execute) → evidence. Returns the gateway lifecycle result; the caller projects it into a content-free
 * HTTP body. Evidence is appended best-effort BEFORE the caller responds, for allowed AND blocked alike.
 */
export async function executeGovernedPullRequest(
  command: GitPullRequestCommand,
  approval: GitDeliveryApprovalRequirement,
  workspace: WorkspaceInfo,
  deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor">,
  seams: GitDeliveryPullRequestSeams,
): Promise<GitPullRequestLifecycleResult> {
  const now = seams.now ?? Date.now;
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
  const adapter = prAdapterFor(workspace, seams, now);
  const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_PR_POLICY_PACK };
  const newActionId =
    seams.newActionId ?? ((): string => defaultGitDeliveryActionId(command, now()));
  const result = await runGitPullRequest(
    { command, approval },
    {
      adapter,
      snapshot,
      ...(packs.orgPack !== undefined ? { orgPolicyPack: packs.orgPack } : {}),
      ...(packs.repoPack !== undefined ? { repoPolicyPack: packs.repoPack } : {}),
      now,
      newActionId,
    },
  );
  persistGitDeliveryEvidence(deps, result.lifecycle, snapshot, workspace.root, now);
  return result;
}

// ─── Deterministic change-narrative derivation (content-free) ─────────────────────────────────────

const CHANGE_TYPE_BY_PREFIX: Readonly<Record<string, GitPrChangeType>> = {
  fix: "fix",
  feat: "feat",
  docs: "docs",
  chore: "chore",
  test: "test",
  refactor: "refactor",
};

function changeTypeFromBranch(headBranch: string): GitPrChangeType {
  const segments = headBranch.split("/");
  const lead = (segments[0] ?? "").toLowerCase();
  return CHANGE_TYPE_BY_PREFIX[lead] ?? "feat";
}

// A best-effort, content-free narrative from the live snapshot: commit count proxied by the ahead-count,
// file count by the working-tree counts, change type inferred from the head-branch namespace. Area tokens
// are intentionally empty here (the snapshot carries no diff paths); the title falls back to the branch
// slug, which is the actual, user-meaningful context.
function narrativeFromSnapshot(
  headBranch: string,
  snapshot: GitWorktreeSnapshot,
): GitPullRequestChangeNarrative {
  return {
    commitCount: Math.max(snapshot.aheadCount, 1),
    fileCount: snapshot.stagedFileCount + snapshot.unstagedFileCount + snapshot.untrackedFileCount,
    areaCount: 0,
    areas: [],
    touchesTests: false,
    changeType: changeTypeFromBranch(headBranch),
  };
}

function commandTitle(command: GitPullRequestCommand): string {
  return command.title;
}

function commandBody(command: GitPullRequestCommand): string {
  return command.body;
}

// ─── Read-only preview projection ──────────────────────────────────────────────────────────────────

export interface GitDeliveryPrReadinessBody {
  readonly objectExists: boolean;
  readonly reviewReady: boolean;
  readonly blockerCodes: readonly string[];
}

export interface GitDeliveryPrPreviewBody {
  readonly schemaVersion: "1";
  readonly actionKind: "pr-create" | "pr-update";
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly riskClass: GitDeliveryRiskClass;
  readonly riskSeverity: number;
  readonly isDraft: boolean;
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
  // The deterministic, user-editable metadata DRAFT (derived from the snapshot + risk + branch context).
  // These are synthesized suggestions, never raw diff content or secrets.
  readonly composedTitle: string;
  readonly composedBody: string;
  readonly riskNarrative: string;
  readonly recommendation: string;
  readonly readiness: GitDeliveryPrReadinessBody;
  readonly suggestedLabels: readonly string[];
  readonly suggestedIssueRefs: readonly string[];
  readonly titleByteLength: number;
  readonly bodyByteLength: number;
}

const UTF8 = new TextEncoder();

function riskDigestFor(
  command: GitPullRequestCommand,
  policyOutcome: GitPullRequestRiskDigest["policyOutcome"],
): GitPullRequestRiskDigest {
  const riskClass: GitDeliveryRiskClass = "protected-or-merge";
  return {
    riskClass,
    riskSeverity: GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass],
    policyOutcome,
    isDraft: command.kind === "pr-create" ? command.isDraft : command.convertToDraft,
  };
}

function previewReadiness(
  command: GitPullRequestCommand,
  snapshot: GitWorktreeSnapshot,
): GitPullRequestReadinessSummary {
  return gitPullRequestReadinessFor({
    headBranchName: command.headBranchName,
    baseBranchName: command.baseBranchName,
    // A PR can only be opened from a published head; the current branch's upstream is the proxy.
    headPublished: snapshot.hasUpstream,
    baseExists: true,
  });
}

// Assembles an editable Markdown body seed from the synthesized draft + linkage refs.
function composeBody(draft: GitPullRequestMetadataDraft, issueRefs: readonly string[]): string {
  const linkage = issueRefs.length > 0 ? `\n\n## Linked issues\nRefs ${issueRefs.join(", ")}` : "";
  return `## Summary\n${draft.composedTitle}\n\n## Risk\n${draft.riskNarrative}${linkage}`;
}

interface PrPreviewParts {
  readonly effectiveOutcome: GitPullRequestRiskDigest["policyOutcome"];
  readonly blockReason?: string;
  readonly riskDigest: GitPullRequestRiskDigest;
  readonly draft: GitPullRequestMetadataDraft;
  readonly readiness: GitPullRequestReadinessSummary;
  readonly recommendation: string;
  readonly labels: readonly string[];
  readonly linkage: readonly string[];
}

function derivePrPreviewParts(
  command: GitPullRequestCommand,
  snapshot: GitWorktreeSnapshot,
  packs: GitDeliveryTrustedPolicyPacks,
): PrPreviewParts {
  const decision = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
    actionKind: command.kind,
    targetBranchName: command.baseBranchName,
    activeProviderCapabilities: [],
  });
  const effective = evaluateGitPullRequestEffectivePolicy(
    decision,
    command.baseBranchName,
    [],
    command.kind,
  );
  const narrative = narrativeFromSnapshot(command.headBranchName, snapshot);
  const riskDigest = riskDigestFor(command, effective.outcome);
  const draft = synthesizePullRequestMetadata(
    narrative,
    riskDigest,
    command.headBranchName,
    command.baseBranchName,
  );
  const readiness = previewReadiness(command, snapshot);
  return {
    effectiveOutcome: effective.outcome,
    ...(effective.blockReason !== undefined ? { blockReason: effective.blockReason } : {}),
    riskDigest,
    draft,
    readiness,
    recommendation: gitPullRequestRecommendationFor(readiness, riskDigest),
    labels: gitPullRequestLabelSuggestionsFor(narrative).suggestedLabelNames,
    linkage: gitPullRequestLinkageSuggestionsFor(command.headBranchName).suggestedIssueRefs,
  };
}

export function buildGitDeliveryPrPreview(
  command: GitPullRequestCommand,
  snapshot: GitWorktreeSnapshot,
  packs: GitDeliveryTrustedPolicyPacks,
): GitDeliveryPrPreviewBody {
  const parts = derivePrPreviewParts(command, snapshot, packs);
  return {
    schemaVersion: "1",
    actionKind: command.kind,
    headBranchName: command.headBranchName,
    baseBranchName: command.baseBranchName,
    riskClass: parts.riskDigest.riskClass,
    riskSeverity: parts.riskDigest.riskSeverity,
    isDraft: parts.riskDigest.isDraft,
    policyOutcome: parts.effectiveOutcome,
    ...(parts.blockReason !== undefined ? { policyBlockReason: parts.blockReason } : {}),
    composedTitle: parts.draft.composedTitle,
    composedBody: composeBody(parts.draft, parts.linkage),
    riskNarrative: parts.draft.riskNarrative,
    recommendation: parts.recommendation,
    readiness: {
      objectExists: parts.readiness.objectExists,
      reviewReady: parts.readiness.reviewReady,
      blockerCodes: parts.readiness.blockers.map((b) => b.code),
    },
    suggestedLabels: parts.labels,
    suggestedIssueRefs: parts.linkage,
    titleByteLength: UTF8.encode(commandTitle(command)).length,
    bodyByteLength: UTF8.encode(commandBody(command)).length,
  };
}

// ─── Execute response projection ─────────────────────────────────────────────────────────────────

export interface GitDeliveryPrExecuteResponseBody extends GitDeliveryMutationResponseBody {
  // Present only when an executed PR operation was rejected by the provider: the precise, content-free
  // rejection reason and the reused recovery disposition / action hint (AC3/AC4).
  readonly prRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
  // Provider-assigned PR number on a successful create.
  readonly createdPrExternalId?: string;
}

export function gitDeliveryPrExecuteResponse(
  result: GitPullRequestLifecycleResult,
): GitDeliveryPrExecuteResponseBody {
  const base = gitDeliveryMutationResponse(result.lifecycle);
  const withId: GitDeliveryPrExecuteResponseBody =
    result.createdPrExternalId !== undefined
      ? { ...base, createdPrExternalId: result.createdPrExternalId }
      : base;
  if (result.rejection === undefined) {
    return withId;
  }
  return {
    ...withId,
    prRejectionReason: result.rejection.reason,
    recoveryDisposition: result.rejection.disposition,
    ...(result.rejection.actionHint !== undefined
      ? { recoveryActionHint: result.rejection.actionHint }
      : {}),
  };
}
