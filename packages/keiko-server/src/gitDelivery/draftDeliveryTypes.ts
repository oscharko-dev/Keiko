import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import type { CodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts";
import type {
  DraftDeliveryRecord,
  DraftDeliveryReason,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type {
  GitPullRequestInspectionAdapter,
  GitPushCommand,
  GitPrCreateCommand,
  GitPullRequestBodyAdapter,
} from "@oscharko-dev/keiko-tools";
import type {
  CodingRuntimeDeliveryResult,
  CodingRuntimeDeliveryReview,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type { GitDeliveryApprovalBinding, GitDeliveryIssuedApproval } from "./approvalStore.js";
import type { CodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
import type { GitDeliveryExecutionSeams, GitDeliveryMutationDeps } from "./execution.js";
import type { GitDeliveryPublishSeams } from "./pushExecution.js";
import type { GitDeliveryPullRequestSeams } from "./prExecution.js";
import type { CodingWorkbenchCodeTaskDeliveryAction } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

export interface DraftDeliveryRunContext extends VerifiedCommitRunContext {
  readonly taskId: string;
  readonly workspaceId: string;
  /** Absent for an issue-free run, which delivers by pushing its own task branch (ADR-0085 D1b). */
  readonly issueBinding?: CodingWorkbenchIssueBinding;
}

/** A run context whose accepted issue exists: the only one that resolves a GitHub target or opens a PR. */
export interface IssueBoundDraftDeliveryRunContext extends DraftDeliveryRunContext {
  readonly issueBinding: CodingWorkbenchIssueBinding;
}

export function isIssueBoundContext(
  context: DraftDeliveryRunContext,
): context is IssueBoundDraftDeliveryRunContext {
  return context.issueBinding !== undefined;
}

/**
 * An issue-free run whose `origin` was admitted as a verified github.com repository. It opens a
 * draft pull request without an accepted issue; an issue only ever links one (ADR-0086 D13).
 */
export function isGitHubOriginContext(context: DraftDeliveryRunContext): boolean {
  return context.issueBinding === undefined && context.repositoryKind === "github-origin";
}

/**
 * The closed outcome of verifying an issue-free run's `origin` before a branch push. A github.com
 * origin also names its live `owner/repository`, whose identity digest equals the run's own.
 */
export type DraftBranchTargetResolution =
  | { readonly ok: true; readonly repository?: string }
  | {
      readonly ok: false;
      readonly reason: "remote-drift" | "provider-failed" | "authority-denied";
    };

export type DraftDeliveryTargetResolution =
  | { readonly ok: true; readonly repository: string }
  | {
      readonly ok: false;
      readonly reason: "issue-drift" | "remote-drift" | "provider-failed" | "authority-denied";
    };

/** Production composition retains the existing GitHub credential and checkout authority owners. */
export interface DraftDeliveryDependencies {
  readonly journeyReader?: (
    context: DraftDeliveryRunContext,
  ) => import("@oscharko-dev/keiko-tools/internal/git-mutation").GitJourneyReader | undefined;
  readonly ciReader?: (
    context: DraftDeliveryRunContext,
  ) => import("@oscharko-dev/keiko-tools/internal/git-mutation").GitCiProviderReader | undefined;
  readonly snapshots: Pick<
    CodingRuntimeSnapshotStore,
    | "get"
    | "recordDraftDelivery"
    | "adoptDraftDeliveryFromPredecessor"
    | "ciReadiness"
    | "ciRepairBudget"
    | "getLastSuccessfulVerifiedCommit"
  >;
  readonly mutationDeps: GitDeliveryMutationDeps;
  readonly execution?: GitDeliveryExecutionSeams;
  /** Revalidates the frozen issue, canonical origin and the current default base before dispatch. */
  /**
   * The bound issue's same-repository references that resolve through the authorized reader, for
   * the pull request's related-issue line. Best effort: an unavailable answer is no line, never a
   * refused delivery. Absent in compositions without an issue reader.
   */
  readonly resolveRelatedIssues?: (
    context: IssueBoundDraftDeliveryRunContext,
  ) => Promise<readonly number[]>;
  /**
   * The repository a pull request opens in. An issue-bound run re-reads its frozen issue; an
   * issue-free run on a github.com origin is re-verified against its admitted identity and the
   * checkout's GitHub grant, and no issue is read.
   */
  readonly resolveTarget: (
    context: DraftDeliveryRunContext,
  ) => Promise<DraftDeliveryTargetResolution>;
  /**
   * Verifies an issue-free run's `origin` before a branch push: still the remote the run was
   * admitted with, not a local-only repository, and, when its push URL is canonical GitHub, the
   * URL `publishSeams` may then use. Absent in compositions without a checkout authority.
   */
  readonly resolveBranchTarget?: (
    context: DraftDeliveryRunContext,
  ) => Promise<DraftBranchTargetResolution>;
  readonly inspectionAdapter: (
    context: DraftDeliveryRunContext,
  ) => GitPullRequestInspectionAdapter | undefined;
  readonly publishSeams: (context: DraftDeliveryRunContext) => GitDeliveryPublishSeams;
  readonly pullRequestSeams: (context: DraftDeliveryRunContext) => GitDeliveryPullRequestSeams;
  /**
   * Reads and replaces the delivered pull request's body for the Checks refresh after a later push
   * (draftDeliveryChecksRefresh.ts). Absent in compositions without a pull request provider.
   */
  readonly bodyAdapter?: (
    context: DraftDeliveryRunContext,
  ) => GitPullRequestBodyAdapter | undefined;
}

export interface DraftDeliveryServiceOptions extends DraftDeliveryDependencies {
  readonly context: () => DraftDeliveryRunContext | undefined;
  /**
   * The run this service belongs to. Only names a refusal when `context` resolves nothing, so the
   * Activity Log still carries the run and its correlation.
   */
  readonly runId?: string;
  /** See VerifiedCommitServiceOptions.policyAllowsWithoutApproval. */
  readonly policyAllowsWithoutApproval?:
    ((action: CodingWorkbenchCodeTaskDeliveryAction) => boolean) | undefined;
  /** Existing runtime event ingestion refreshes the public snapshot after every durable phase. */
  readonly onChanged: (record: DraftDeliveryRecord) => void;
}

export interface DraftDeliveryProposal {
  readonly record: DraftDeliveryRecord;
  readonly review: CodingRuntimeDeliveryReview;
  readonly approvalBinding: GitDeliveryApprovalBinding;
  readonly expiresAtMs: number;
}

export interface PreparedDraftDelivery extends DraftDeliveryProposal {
  readonly command: GitPushCommand | GitPrCreateCommand;
  readonly expectedRemoteHead: string | undefined;
}

export interface DraftDeliveryService {
  proposePush(): Promise<CodingRuntimeDeliveryResult>;
  proposePullRequest(title: string): Promise<CodingRuntimeDeliveryResult>;
  reconcile(): Promise<CodingRuntimeDeliveryResult>;
  review(proposalId: string): DraftDeliveryProposal | undefined;
  issueApproval(proposalId: string): GitDeliveryIssuedApproval | undefined;
  matchesApproval(proposalId: string): boolean;
  consumeApproval(proposalId: string): object | undefined;
  executeApproved(
    proposalId: string,
    lease: object | undefined,
    guard: {
      readonly check: () => boolean;
      readonly intent?: "push" | "pull-request" | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<CodingRuntimeDeliveryResult>;
  invalidate(): void;
}

export class DraftDeliveryFailure extends Error {
  public constructor(
    public readonly reason: DraftDeliveryReason,
    public readonly pullRequest?: GitPullRequestIdentity,
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "DraftDeliveryFailure";
  }
}
