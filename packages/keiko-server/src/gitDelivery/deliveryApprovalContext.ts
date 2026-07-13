import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  evaluateGitPolicy,
  validateGitCommitMessage,
  type GitCommitMessagePolicy,
  type GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPreflight,
  type GitMutationCommand,
  type GitPullRequestCommand,
  type GitPushCommand,
} from "@oscharko-dev/keiko-tools";
import type { GitDeliveryApprovalBinding } from "./approvalStore.js";
import { buildDeliveryApprovalBinding, type GitDeliveryApprovalSeams } from "./deliveryApproval.js";
import {
  KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK,
  readStagedPathsFor,
  readWorktreeSnapshotFor,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  buildGitDeliveryPrPreview,
  KEIKO_DEFAULT_PR_POLICY_PACK,
  type GitDeliveryPullRequestSeams,
} from "./prExecution.js";
import {
  buildGitDeliveryPushPreview,
  KEIKO_DEFAULT_PUBLISH_POLICY_PACK,
  type GitDeliveryPublishSeams,
} from "./pushExecution.js";

type CommitCommand = Extract<GitMutationCommand, { readonly kind: "commit" }>;

export async function buildCommitApprovalBinding(input: {
  readonly projectId: string;
  readonly command: CommitCommand;
  readonly workspace: WorkspaceInfo;
  readonly messagePolicy: GitCommitMessagePolicy;
  readonly seams: GitDeliveryExecutionSeams & GitDeliveryApprovalSeams;
}): Promise<GitDeliveryApprovalBinding> {
  const now = input.seams.now ?? Date.now;
  const [snapshot, stagedPaths] = await Promise.all([
    readWorktreeSnapshotFor(input.workspace, input.seams, now),
    readStagedPathsFor(input.workspace, input.seams, now),
  ]);
  const resolved: GitDeliveryResolvedInputs = {
    kind: "commit",
    messageByteLength: Buffer.byteLength(input.command.message, "utf8"),
    stagedPathCount: snapshot.stagedFileCount,
    allowEmptyCommit: input.command.allowEmpty,
  };
  const packs = input.seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK };
  const preview = {
    messageValidation: validateGitCommitMessage(input.command.message, input.messagePolicy),
    policy: evaluateGitPolicy(packs.orgPack, packs.repoPack, {
      actionKind: "commit",
      ...(snapshot.currentBranchName === undefined
        ? {}
        : { targetBranchName: snapshot.currentBranchName }),
      activeProviderCapabilities: [],
    }),
    preflight: evaluateGitPreflight(resolved, snapshot),
    stagedPaths,
  };
  return buildDeliveryApprovalBinding({
    projectId: input.projectId,
    actionKind: "commit",
    command: input.command,
    preview,
    snapshot,
    workspace: input.workspace,
    seams: input.seams,
  });
}

export async function buildPushApprovalBinding(input: {
  readonly projectId: string;
  readonly command: GitPushCommand;
  readonly workspace: WorkspaceInfo;
  readonly seams: GitDeliveryPublishSeams & GitDeliveryApprovalSeams;
}): Promise<GitDeliveryApprovalBinding> {
  const now = input.seams.now ?? Date.now;
  const snapshot = await readWorktreeSnapshotFor(input.workspace, input.seams, now);
  const packs = input.seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_PUBLISH_POLICY_PACK };
  return buildDeliveryApprovalBinding({
    projectId: input.projectId,
    actionKind: "push",
    command: input.command,
    preview: buildGitDeliveryPushPreview(input.command, snapshot, packs),
    snapshot,
    workspace: input.workspace,
    seams: input.seams,
  });
}

export async function buildPrApprovalBinding(input: {
  readonly projectId: string;
  readonly command: GitPullRequestCommand;
  readonly workspace: WorkspaceInfo;
  readonly seams: GitDeliveryPullRequestSeams & GitDeliveryApprovalSeams;
}): Promise<GitDeliveryApprovalBinding> {
  const now = input.seams.now ?? Date.now;
  const snapshot = await readWorktreeSnapshotFor(input.workspace, input.seams, now);
  const packs = input.seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_PR_POLICY_PACK };
  return buildDeliveryApprovalBinding({
    projectId: input.projectId,
    actionKind: input.command.kind,
    command: input.command,
    preview: buildGitDeliveryPrPreview(input.command, snapshot, packs),
    snapshot,
    workspace: input.workspace,
    seams: input.seams,
  });
}
