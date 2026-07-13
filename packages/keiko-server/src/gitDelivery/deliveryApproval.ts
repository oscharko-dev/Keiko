import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryIssuedApproval,
  type GitDeliverySeparatelyApprovedActionKind,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { DEFAULT_SANDBOX_POLICY, type GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import { GIT_WORKTREE_READ_COMMAND_RULES } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { nodeSpawnFn, runCommand } from "@oscharko-dev/keiko-tools/internal/exec";
import {
  createInMemoryGitDeliveryApprovalStore,
  type GitDeliveryApprovalBinding,
  type GitDeliveryApprovalStore,
} from "./approvalStore.js";

export interface GitDeliveryLiveApprovalFacts {
  readonly headRefHash: string;
  readonly stagedStateSha256: string;
}

export interface GitDeliveryApprovalSeams {
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly approvalFactsReader?:
    ((workspace: WorkspaceInfo) => Promise<GitDeliveryLiveApprovalFacts>) | undefined;
}

export type GitDeliveryApprovalContextGuard = () => Promise<boolean>;

export const PRODUCTION_GIT_DELIVERY_APPROVAL_STORE: GitDeliveryApprovalStore =
  createInMemoryGitDeliveryApprovalStore();

export function approvalStoreFor(seams: GitDeliveryApprovalSeams): GitDeliveryApprovalStore {
  return seams.approvalStore ?? PRODUCTION_GIT_DELIVERY_APPROVAL_STORE;
}

export function createDeliveryApprovalContextGuard(
  approved: GitDeliveryApprovalBinding,
  readCurrent: () => Promise<GitDeliveryApprovalBinding>,
): GitDeliveryApprovalContextGuard {
  return async (): Promise<boolean> => {
    if (approved.contextDigest === undefined) return false;
    const current = await readCurrent();
    return current.contextDigest === approved.contextDigest;
  };
}

async function readGit(workspace: WorkspaceInfo, args: readonly string[]): Promise<string> {
  const result = await runCommand(
    {
      command: "git",
      args,
      cwd: undefined,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    },
    {
      workspace,
      policy: DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_WORKTREE_READ_COMMAND_RULES,
      spawn: nodeSpawnFn,
      processEnv: process.env,
      now: Date.now,
    },
  );
  if (result.exitCode !== 0) throw new Error("git-delivery-approval-facts-unavailable");
  return result.stdout;
}

export async function readLiveGitDeliveryApprovalFacts(
  workspace: WorkspaceInfo,
): Promise<GitDeliveryLiveApprovalFacts> {
  const [head, staged] = await Promise.all([
    readGit(workspace, ["rev-parse", "--verify", "HEAD"]),
    readGit(workspace, ["diff", "--cached", "--raw", "--no-renames"]),
  ]);
  const headRefHash = head.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headRefHash)) {
    throw new Error("git-delivery-approval-head-invalid");
  }
  return { headRefHash, stagedStateSha256: sha256Hex(staged) };
}

export function approvalFactsFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryApprovalSeams,
): Promise<GitDeliveryLiveApprovalFacts> {
  return seams.approvalFactsReader?.(workspace) ?? readLiveGitDeliveryApprovalFacts(workspace);
}

export async function buildDeliveryApprovalBinding(input: {
  readonly projectId: string;
  readonly actionKind: GitDeliverySeparatelyApprovedActionKind;
  readonly command: unknown;
  readonly preview: unknown;
  readonly snapshot: GitWorktreeSnapshot;
  readonly workspace: WorkspaceInfo;
  readonly seams: GitDeliveryApprovalSeams;
}): Promise<GitDeliveryApprovalBinding> {
  const facts = await approvalFactsFor(input.workspace, input.seams);
  const contextDigest = sha256Hex(
    canonicalise({ facts, preview: input.preview, snapshot: input.snapshot }),
  );
  return {
    projectId: input.projectId,
    operation: input.actionKind,
    command: input.command,
    contextDigest,
  };
}

export function issueDeliveryApproval(input: {
  readonly store: GitDeliveryApprovalStore;
  readonly binding: GitDeliveryApprovalBinding;
  readonly actionKind: GitDeliverySeparatelyApprovedActionKind;
  readonly nowMs: number;
}): GitDeliveryIssuedApproval {
  const issued = input.store.issue({
    binding: input.binding,
    approvedByUserId: "local-operator",
    nowMs: input.nowMs,
  });
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    actionKind: input.actionKind,
    approval: issued.approval,
    expiresAtMs: issued.expiresAtMs,
  };
}
