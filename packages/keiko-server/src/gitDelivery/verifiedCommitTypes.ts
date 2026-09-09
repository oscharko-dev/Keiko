import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  VerificationReport,
  GitDeliveryApprovalClaim,
  GitCommitMessageValidation,
} from "@oscharko-dev/keiko-contracts";
import type {
  VerifiedCommitBinding,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import type { GitDeliveryExecutionSeams, GitDeliveryMutationDeps } from "./execution.js";
import type { CodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import type { GitCommitCommand } from "@oscharko-dev/keiko-tools";
import type { GitDeliveryIssuedApproval } from "./approvalStore.js";
import type { CodingWorkbenchCodeTaskDeliveryAction } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

/** Entirely server-resolved accepted authority. Browser/model inputs cannot provide these facts. */
export interface VerifiedCommitRunContext {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly runtimeAuthorityDigest: string;
  readonly workspaceDigest: string;
  readonly repositoryDigest: string;
  readonly workspace: WorkspaceInfo;
  readonly baseRef: string;
  readonly headRef: string;
  readonly issueBindingDigest?: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly buffersClean: () => boolean;
  readonly stillAuthorized: () => boolean;
}

export interface VerifiedCommitFacts {
  readonly headSha: string;
  readonly baseSha: string;
  readonly stagedTreeDigest: string;
  readonly repositoryDigest: string;
  readonly clean: boolean;
}

export interface VerifiedCommitProposal {
  readonly binding: VerifiedCommitBinding;
  readonly command: GitCommitCommand;
  readonly context: VerifiedCommitRunContext;
  readonly expiresAtMs: number;
  readonly review: import("@oscharko-dev/keiko-contracts").CodingWorkbenchRuntimePendingApprovalReview;
}

export interface VerifiedCommitServiceOptions {
  readonly context: () => VerifiedCommitRunContext | undefined;
  /**
   * Trusted live mode decision. This is necessary but never sufficient: callers must also supply
   * the exact coding-tool mutation guard, which revalidates the complete Authority Envelope.
   */
  readonly policyAllowsWithoutApproval?:
    ((action: CodingWorkbenchCodeTaskDeliveryAction) => boolean) | undefined;
  readonly snapshots: Pick<
    CodingRuntimeSnapshotStore,
    "get" | "recordVerifiedCommit" | "getLastSuccessfulVerifiedCommit"
  >;
  readonly mutationDeps: GitDeliveryMutationDeps;
  readonly execution?: GitDeliveryExecutionSeams;
  // A plain `boolean` stays accepted (existing wiring keeps compiling unchanged), but a caller
  // SHOULD return the full `GitCommitMessageValidation` so a "blocked"/"message-policy" result can
  // carry the closed violation codes the pure validator already computed (#3390) instead of only
  // the boolean the kernel gate needs — see VerifiedCommitResult["violations"].
  readonly messageAllowed: (
    message: string,
    workspace: WorkspaceInfo,
  ) => Promise<boolean | GitCommitMessageValidation>;
}

export interface VerifiedCommitService {
  /** The returned identity is server-held and cannot be reconstructed from serialized values. */
  beginVerification(): Promise<object | undefined>;
  completeVerification(
    ticket: object,
    report: VerificationReport,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
  ): Promise<boolean>;
  propose(message: string): Promise<VerifiedCommitResult | undefined>;
  approve(proposalId: string): Promise<GitDeliveryApprovalClaim | undefined>;
  /** Synchronous human-decision surface; execution still rechecks every live candidate fact. */
  issueApproval(proposalId: string): GitDeliveryIssuedApproval | undefined;
  // #3384 F4: `approval` accepts `undefined` (a binding-matched, un-tokened redemption is a
  // legitimate call shape — see `consumeApproval`'s own optional `approval`) and `guard` mirrors
  // `executeApproved`'s optional revalidation seam, so a claim-based caller (the tool-authority
  // admission path) gets this method's already-correct preflightBlock -> consumeApproval ->
  // executeConsumed order without needing the lease pre-consumed at admission time.
  execute(
    proposalId: string,
    approval: GitDeliveryApprovalClaim | undefined,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
  ): Promise<VerifiedCommitResult | undefined>;
  matchesApproval(proposalId: string, approval?: GitDeliveryApprovalClaim): boolean;
  /** One-use, server-held execution lease. Its identity is not serializable authority. */
  consumeApproval(proposalId: string, approval?: GitDeliveryApprovalClaim): object | undefined;
  executeApproved(
    proposalId: string,
    lease: object,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
  ): Promise<VerifiedCommitResult | undefined>;
  review(proposalId: string): VerifiedCommitProposal | undefined;
  invalidate(): void;
  reconcile(): Promise<VerifiedCommitResult | undefined>;
}
