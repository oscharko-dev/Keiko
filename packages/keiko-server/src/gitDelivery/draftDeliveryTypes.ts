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

export interface DraftDeliveryRunContext extends VerifiedCommitRunContext {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly issueBinding: CodingWorkbenchIssueBinding;
}

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
  >;
  readonly mutationDeps: GitDeliveryMutationDeps;
  readonly execution?: GitDeliveryExecutionSeams;
  /** Revalidates the frozen issue, canonical origin and the current default base before dispatch. */
  readonly resolveTarget: (
    context: DraftDeliveryRunContext,
  ) => Promise<DraftDeliveryTargetResolution>;
  readonly inspectionAdapter: (
    context: DraftDeliveryRunContext,
  ) => GitPullRequestInspectionAdapter | undefined;
  readonly publishSeams: (context: DraftDeliveryRunContext) => GitDeliveryPublishSeams;
  readonly pullRequestSeams: (context: DraftDeliveryRunContext) => GitDeliveryPullRequestSeams;
}

export interface DraftDeliveryServiceOptions extends DraftDeliveryDependencies {
  readonly context: () => DraftDeliveryRunContext | undefined;
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
    lease: object,
    guard: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
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
