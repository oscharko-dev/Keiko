// Governed local Git execution core for the #475 branch/staging/commit routes (Epic #470).
//
// Both #475 route groups (localMutationRoutes, commitRoutes) share ONE execution path: resolve and
// authorize the project workspace, build a TRUSTWORTHY snapshot from the live worktree, drive the
// #472 kernel `runGitMutation` (the sole execution authority — preflight + policy + approval gates),
// and append a content-free evidence record through the #474 ledger. No second orchestrator, no
// generic shell, no terminal-allowlist widening. The git Node effect (adapter + reader) is injected
// via seams so route tests run deterministically against a fake repository.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  type GitDeliveryActionKind,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  buildGitDeliveryEvidenceRecord,
  runGitMutation,
  type GitLocalMutationAdapter,
  type GitMutationCommand,
  type GitMutationLifecycleResult,
  type GitMutationOutcome,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import {
  createNodeGitMutationAdapter,
  readGitWorktreeSnapshot,
  readStagedPaths,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { UiHandlerDeps } from "../deps.js";
import { resolveRegisteredOrManagedWorkspaceRoot } from "../task-workspace/authorization.js";
import type { GitDeliveryApprovalStore } from "./approvalStore.js";
import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import { recordGitDeliveryMutationEvidence } from "./mutationEvidenceLedger.js";

// Default trusted policy: PERMIT the lowest risk class (local-mutation = branch create/switch, stage,
// unstage, commit) and fail-closed for everything else (publish / protected-or-merge / recovery). It
// applies when no stricter pack is configured. The decision is still EVALUATED for every action —
// governance is preserved.
export const KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "keiko-local-default",
  rules: [],
  defaultRule: {
    decision: "constrained",
    constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
  },
};

export interface GitDeliveryExecutionSeams {
  readonly adapterFactory?: ((workspace: WorkspaceInfo) => GitLocalMutationAdapter) | undefined;
  readonly snapshotReader?:
    ((workspace: WorkspaceInfo) => Promise<GitWorktreeSnapshot>) | undefined;
  readonly stagedPathsReader?:
    ((workspace: WorkspaceInfo) => Promise<readonly string[]>) | undefined;
  readonly policyPacks?: GitDeliveryTrustedPolicyPacks | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly now?: (() => number) | undefined;
  readonly newActionId?: (() => string) | undefined;
}

// projectId IS the workspace root path (mirrors the terminal execution manager). Resolving it through
// the UI project store both AUTHORIZES the path (only a registered project may be mutated) and yields
// the WorkspaceInfo the spawn boundary runs in.
export function resolveProjectWorkspace(
  deps: Pick<UiHandlerDeps, "managedTaskWorkspaceRoot" | "store" | "workspaceProvisioning">,
  projectId: string,
): WorkspaceInfo | undefined {
  return resolveRegisteredOrManagedWorkspaceRoot(deps, projectId);
}

export function readWorktreeSnapshotFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
): Promise<GitWorktreeSnapshot> {
  if (seams.snapshotReader !== undefined) return seams.snapshotReader(workspace);
  return readGitWorktreeSnapshot({ workspace, processEnv: process.env, now });
}

export function readStagedPathsFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
): Promise<readonly string[]> {
  if (seams.stagedPathsReader !== undefined) return seams.stagedPathsReader(workspace);
  return readStagedPaths({ workspace, processEnv: process.env, now });
}

function adapterFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
): GitLocalMutationAdapter {
  if (seams.adapterFactory !== undefined) return seams.adapterFactory(workspace);
  return createNodeGitMutationAdapter({ workspace, processEnv: process.env, now });
}

export function defaultGitDeliveryActionId(command: unknown, nowMs: number): string {
  return `gde-action-${sha256Hex(`${JSON.stringify(command)}:${String(nowMs)}`).slice(0, 24)}`;
}

// String-leaf redactor for the evidence ledger, reusing the deps payload redactor (deepRedactStrings
// applies the inner audit redactString to a top-level string leaf). No new regex.
function redactStringFor(deps: Pick<UiHandlerDeps, "redactor">): (input: string) => string {
  return (input: string): string => deps.redactor(input) as string;
}

export function persistGitDeliveryEvidence(
  deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor">,
  result: GitMutationLifecycleResult,
  snapshot: GitWorktreeSnapshot,
  repoId: string,
  now: () => number,
): void {
  const record = buildGitDeliveryEvidenceRecord(
    {
      result,
      snapshot: {
        headDetached: snapshot.headDetached,
        ...(snapshot.currentBranchName !== undefined
          ? { currentBranchName: snapshot.currentBranchName }
          : {}),
        stagedFileCount: snapshot.stagedFileCount,
        unstagedFileCount: snapshot.unstagedFileCount,
        untrackedFileCount: snapshot.untrackedFileCount,
      },
      workflowRunId: `local-git-delivery:${repoId}`,
      repoId,
    },
    { now },
  );
  recordGitDeliveryMutationEvidence(
    { evidenceStore: deps.evidenceStore, redactString: redactStringFor(deps) },
    record,
  );
}

/**
 * Runs ONE governed local mutation end-to-end: live snapshot → kernel (preflight + policy + approval +
 * execute) → evidence. Returns the kernel lifecycle result; the caller projects it into a content-free
 * HTTP body. Evidence is appended best-effort BEFORE the caller responds.
 */
export async function executeGovernedMutation(
  command: GitMutationCommand,
  approval: GitDeliveryApprovalRequirement,
  workspace: WorkspaceInfo,
  deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor">,
  seams: GitDeliveryExecutionSeams,
): Promise<GitMutationLifecycleResult> {
  const now = seams.now ?? Date.now;
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
  const adapter = adapterFor(workspace, seams, now);
  const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK };
  const newActionId =
    seams.newActionId ?? ((): string => defaultGitDeliveryActionId(command, now()));
  const result = await runGitMutation(
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
  persistGitDeliveryEvidence(deps, result, snapshot, workspace.root, now);
  return result;
}

// ─── Content-free response projection ──────────────────────────────────────────────────────────

export interface GitDeliveryMutationResponseBody {
  readonly schemaVersion: "1";
  readonly status: GitMutationOutcome["status"];
  readonly actionKind: GitDeliveryActionKind;
  readonly phaseReached: GitMutationLifecycleResult["phaseReached"];
  readonly policyOutcome: GitMutationLifecycleResult["envelope"]["policyDecision"]["outcome"];
  readonly blockReason?: string;
  readonly preflightFindingCodes?: readonly string[];
  readonly requiredApprovers?: readonly string[];
  readonly executionErrorCode?: string;
}

export function gitDeliveryMutationResponse(
  result: GitMutationLifecycleResult,
): GitDeliveryMutationResponseBody {
  const { outcome, envelope, phaseReached, preflight } = result;
  const base = {
    schemaVersion: "1" as const,
    status: outcome.status,
    actionKind: envelope.kind,
    phaseReached,
    policyOutcome: envelope.policyDecision.outcome,
  };
  if (outcome.status === "blocked") {
    return outcome.category === "policy-block"
      ? { ...base, blockReason: outcome.blockReason }
      : { ...base, preflightFindingCodes: preflight.blocking.map((f) => f.code) };
  }
  if (outcome.status === "approval-required") {
    return { ...base, requiredApprovers: outcome.requiredApprovers };
  }
  if (outcome.status === "failed" || outcome.status === "recovery-required") {
    return { ...base, executionErrorCode: outcome.executionResult.errorCode ?? "internal-error" };
  }
  return base;
}
