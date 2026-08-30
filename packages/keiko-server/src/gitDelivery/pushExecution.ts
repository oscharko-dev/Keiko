// Governed remote publish execution core for the #476 push routes (Epic #470, ADR-0063).
//
// The push preview + execute routes share ONE path: resolve and authorize the project workspace, build
// a TRUSTWORTHY snapshot from the live worktree, drive the #476 publish gateway `runGitPublish` (the
// SEPARATE remote execution authority — preflight + policy + approval gates, executing through a narrow
// remote adapter with a dedicated push-only allowlist), and append a content-free evidence record through
// the #474 ledger for EVERY terminal outcome (allowed and blocked alike — AC5). No second orchestrator,
// no generic shell, no widening of the local mutation or read-only inspection allowlists. The Node push
// effect is injected via seams so route tests run deterministically against a fake remote.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryProtectedBranchConstraint,
  GitDeliveryPushInputs,
  GitDeliveryRepoPolicyPack,
  GitDeliveryRiskClass,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  evaluateGitPolicy,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import { gitDeliveryRiskClassForInputs } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import {
  evaluateGitPreflight,
  evaluateGitPublishEffectivePolicy,
  runGitPublish,
  type GitPublishExecResult,
  type GitPublishLifecycleResult,
  type GitPushCommand,
  type GitRemotePublishAdapter,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import { createNodeGitPublishAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type { GitDeliveryApprovalStore } from "./approvalStore.js";
import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import type {
  GitDeliveryBranchProtectionReader,
  GitDeliverySignatureRequirement,
} from "./branchProtectionPreflight.js";
import {
  defaultGitDeliveryActionId,
  gitDeliveryMutationResponse,
  gitDeliveryTerminationHandler,
  logGitDeliveryNoSpawnRefusal,
  persistGitDeliveryEvidence,
  readWorktreeSnapshotFor,
  type GitDeliveryMutationResponseBody,
} from "./execution.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { GitDeliveryAuthorityContinuityDenialCapture } from "./requestPreparation.js";

// The shared/protected remote branches a governed push may never target directly. This is the
// enforcement of the "no direct push to dev" hard denial (and its equivalents in a repository that
// names its integration branch differently). It is a DENY list on purpose: the branches Keiko must
// protect are a small, well-known, repository-independent set, whereas the branches a user is
// entitled to push are unbounded and follow whatever convention THEIR repository uses.
const KEIKO_PROTECTED_REMOTE_BRANCHES: GitDeliveryProtectedBranchConstraint = {
  kind: "protected-branch",
  patterns: [
    { matchKind: "exact", value: "dev" },
    { matchKind: "exact", value: "develop" },
    { matchKind: "exact", value: "main" },
    { matchKind: "exact", value: "master" },
    { matchKind: "exact", value: "trunk" },
    { matchKind: "exact", value: "production" },
    { matchKind: "exact", value: "stable" },
    { matchKind: "exact", value: "release" },
    { matchKind: "prefix", value: "release/" },
    { matchKind: "prefix", value: "releases/" },
  ],
};

// Default trusted publish policy: PERMIT `push` to any remote branch that is NOT protected, and only
// within the `publish` risk ceiling (which fail-closed BLOCKS force pushes, classed recovery-or-rewrite).
// A push whose REMOTE target is a shared/protected branch (dev, main, release/*, …) trips the
// protected-branch constraint and is blocked with `protected-branch` (AC2). Every other action kind is
// denied. Applies only when governed git delivery is ENABLED and no stricter pack is configured; the
// decision is still EVALUATED for every push, so governance is preserved.
//
// This deliberately does NOT allow-list branch prefixes. An allow-list of `claude/ feat/ fix/ chore/
// docs/` is Keiko's OWN branch-naming convention; imposing it as the default made the Push control
// unusable in every repository that names branches any other way — a user branch such as `my-work`
// or `bugfix-123` was blocked with `policy-pack-blocked` and no configuration path existed to widen
// it. The hard denial the allow-list was really carrying is the protected-branch one, which is now
// stated directly and covers more names (master, trunk, production, …) than the prefix list ever did.
export const KEIKO_DEFAULT_PUBLISH_POLICY_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "keiko-publish-default",
  rules: [
    {
      actionKind: "push",
      decision: "constrained",
      constraints: [
        { kind: "risk-class-ceiling", maxRiskClass: "publish" },
        KEIKO_PROTECTED_REMOTE_BRANCHES,
      ],
    },
  ],
  defaultRule: { decision: "blocked" },
};

export interface GitDeliveryPublishSeams {
  readonly publishAdapterFactory?:
    ((workspace: WorkspaceInfo) => GitRemotePublishAdapter) | undefined;
  readonly snapshotReader?:
    ((workspace: WorkspaceInfo) => Promise<GitWorktreeSnapshot>) | undefined;
  readonly branchProtectionReader?: GitDeliveryBranchProtectionReader | undefined;
  readonly policyPacks?: GitDeliveryTrustedPolicyPacks | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  // The request's own activity-log sink, so the default publish adapter's runCommand
  // termination-evidence callback (see publishAdapterFor) writes through the SAME sink the caller
  // logs everything else through, instead of an uninjectable `processServerLogSink()`.
  readonly activityLog?: ServerLogSink | undefined;
  readonly now?: (() => number) | undefined;
  readonly newActionId?: (() => string) | undefined;
  readonly beforeRemoteDispatch?: (() => boolean) | undefined;
  // Set by the route alongside `beforeRemoteDispatch` when that guard is the continuity re-check (see
  // GitDeliveryAuthorityContinuityDenialCapture). When present, a continuity denial suppresses evidence
  // persistence for this synthetic, never-executed attempt instead of recording it as a failure.
  readonly authorityDenialCapture?: GitDeliveryAuthorityContinuityDenialCapture | undefined;
}

function authorityGuardedPublishAdapter(
  adapter: GitRemotePublishAdapter,
  beforeRemoteDispatch: (() => boolean) | undefined,
  activityLog: ServerLogSink,
  correlationId: string | undefined,
): GitRemotePublishAdapter {
  if (beforeRemoteDispatch === undefined) return adapter;
  return {
    publish: (request): Promise<GitPublishExecResult> => {
      if (beforeRemoteDispatch()) return adapter.publish(request);
      // F4: no process is spawned for this attempt — mark it explicitly before returning the
      // synthetic result (see logGitDeliveryNoSpawnRefusal in execution.ts).
      logGitDeliveryNoSpawnRefusal(activityLog, "push", correlationId);
      return Promise.resolve({ schemaVersion: "1", outcome: "aborted", durationMs: 0 });
    },
  };
}

function publishAdapterFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryPublishSeams,
  now: () => number,
  correlationId: string | undefined,
): GitRemotePublishAdapter {
  if (seams.publishAdapterFactory !== undefined) return seams.publishAdapterFactory(workspace);
  return createNodeGitPublishAdapter({
    workspace,
    processEnv: process.env,
    now,
    onTerminated: gitDeliveryTerminationHandler(seams, correlationId),
  });
}

function pushInputsOf(command: GitPushCommand): GitDeliveryPushInputs {
  return {
    kind: "push",
    sourceBranchName: command.sourceBranchName,
    remoteAlias: command.remoteAlias,
    remoteBranchName: command.remoteBranchName,
    forcePush: command.forcePush,
    setUpstreamTracking: command.setUpstreamTracking,
  };
}

/**
 * Runs ONE governed publish end-to-end: live snapshot → publish gateway (preflight + policy + approval +
 * execute) → evidence. Returns the gateway lifecycle result; the caller projects it into a content-free
 * HTTP body. Evidence is appended best-effort BEFORE the caller responds, for allowed AND blocked
 * attempts.
 */
export async function executeGovernedPublish(
  command: GitPushCommand,
  approval: GitDeliveryApprovalRequirement,
  workspace: WorkspaceInfo,
  deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor">,
  seams: GitDeliveryPublishSeams,
  correlationId?: string,
): Promise<GitPublishLifecycleResult> {
  const now = seams.now ?? Date.now;
  const activityLog = seams.activityLog ?? processServerLogSink();
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now, correlationId);
  const adapter = authorityGuardedPublishAdapter(
    publishAdapterFor(workspace, seams, now, correlationId),
    seams.beforeRemoteDispatch,
    activityLog,
    correlationId,
  );
  const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_PUBLISH_POLICY_PACK);
  const newActionId =
    seams.newActionId ?? ((): string => defaultGitDeliveryActionId(command, now()));
  const result = await runGitPublish(
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
  // A continuity denial (caught by authorityGuardedPublishAdapter above) means the adapter never
  // dispatched — `result` is the synthetic no-spawn stand-in, not a real attempt. The route returns the
  // captured 403 instead of this result, so recording it here would leave a "failed"/retryable evidence
  // entry for an attempt the client is never told happened. See GitDeliveryAuthorityContinuityDenialCapture.
  if (seams.authorityDenialCapture?.result === undefined) {
    persistGitDeliveryEvidence(deps, result.lifecycle, snapshot, workspace.root, now);
  }
  return result;
}

// ─── Read-only preview projection ────────────────────────────────────────────────────────────────

export interface GitDeliveryPushPreviewBody {
  readonly schemaVersion: "1";
  readonly remoteAlias: string;
  readonly remoteBranchName: string;
  readonly sourceBranchName: string;
  readonly riskClass: GitDeliveryRiskClass;
  readonly wouldCreateRemoteBranch: boolean;
  readonly wouldTriggerChecks: boolean;
  // Force is blocked by default (AC4); the preview states it explicitly so the surface can warn before
  // the user even submits.
  readonly forceBlocked: boolean;
  readonly signatureRequirement: GitDeliverySignatureRequirement;
  readonly preflightBlockingCodes: readonly string[];
  readonly preflightAdvisoryCodes: readonly string[];
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
}

function signatureAdvisoryCodes(requirement: GitDeliverySignatureRequirement): readonly string[] {
  if (requirement === "required") return ["signed-commits-required"];
  return requirement === "unavailable" ? ["branch-protection-unavailable"] : [];
}

// Builds the read-only push preview from a live snapshot: the remote target, the risk summary, the
// preflight findings (incl. non-fast-forward and missing-upstream), and the policy decision — no
// execution, no evidence.
export function buildGitDeliveryPushPreview(
  command: GitPushCommand,
  snapshot: GitWorktreeSnapshot,
  packs: GitDeliveryTrustedPolicyPacks,
  signatureRequirement: GitDeliverySignatureRequirement = "unavailable",
): GitDeliveryPushPreviewBody {
  const inputs = pushInputsOf(command);
  const preflight = evaluateGitPreflight(inputs, snapshot);
  const decision = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
    actionKind: "push",
    targetBranchName: command.remoteBranchName,
    activeProviderCapabilities: [],
  });
  // The EFFECTIVE policy outcome for THIS target, so the preview predicts the execute outcome exactly:
  // a constrained decision is resolved against the target (a protected/shared branch reads as blocked).
  const effective = evaluateGitPublishEffectivePolicy(
    decision,
    command.remoteBranchName,
    [],
    inputs,
  );
  return {
    schemaVersion: "1",
    remoteAlias: command.remoteAlias,
    remoteBranchName: command.remoteBranchName,
    sourceBranchName: command.sourceBranchName,
    riskClass: gitDeliveryRiskClassForInputs(inputs),
    wouldCreateRemoteBranch: command.setUpstreamTracking && !snapshot.hasUpstream,
    wouldTriggerChecks: true,
    forceBlocked: command.forcePush,
    signatureRequirement,
    preflightBlockingCodes: preflight.blocking.map((f) => f.code),
    preflightAdvisoryCodes: [
      ...preflight.advisory.map((f) => f.code),
      ...signatureAdvisoryCodes(signatureRequirement),
    ],
    policyOutcome: effective.outcome,
    ...(effective.outcome === "blocked" ? { policyBlockReason: effective.blockReason } : {}),
  };
}

// ─── Execute response projection ─────────────────────────────────────────────────────────────────

export interface GitDeliveryPushExecuteResponseBody extends GitDeliveryMutationResponseBody {
  // Present only when an executed push was rejected by the remote: the precise, content-free rejection
  // reason and the reused recovery disposition / action hint so the user recovers without guessing (AC3).
  readonly publishRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
}

export function gitDeliveryPublishExecuteResponse(
  result: GitPublishLifecycleResult,
): GitDeliveryPushExecuteResponseBody {
  const base = gitDeliveryMutationResponse(result.lifecycle);
  if (result.rejection === undefined) {
    return base;
  }
  return {
    ...base,
    publishRejectionReason: result.rejection.reason,
    recoveryDisposition: result.rejection.disposition,
    ...(result.rejection.actionHint !== undefined
      ? { recoveryActionHint: result.rejection.actionHint }
      : {}),
  };
}
