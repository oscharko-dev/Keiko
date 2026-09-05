import type { WorkspaceInfo, GitDeliveryApprovalClaim } from "@oscharko-dev/keiko-contracts";
import type {
  PrDescriptionApplicationStatus,
  PrDescriptionApplicationReason,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type {
  PrDescriptionArtifact,
  PrDescriptionLanguage,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import type { PrDescription } from "@oscharko-dev/keiko-model-gateway";
import type { GitPullRequestBodyAdapter, GitPrBody } from "@oscharko-dev/keiko-tools";
import type {
  GitChangeSnapshotService,
  GitChangeSnapshotCaptureInput,
} from "../gitChangeSnapshotService.js";
import type { GitDeliveryMutationDeps } from "./execution.js";
import type { GitDeliveryPullRequestSeams } from "./prExecution.js";
import type { GitDeliveryApprovalBinding, GitDeliveryIssuedApproval } from "./approvalStore.js";

/** Accepted server authority. Generic external PRs do not require a Workbench issue binding. */
export interface PrDescriptionContext {
  readonly workspace: WorkspaceInfo;
  readonly repository: string;
  readonly prNumber: number;
  readonly accessScope: object;
  readonly authorityDigest: string;
  readonly correlationId: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly stillAuthorized: () => boolean;
}
export interface PrDescriptionPreviewRequest {
  readonly language: PrDescriptionLanguage;
  readonly refinement?: string;
}
export interface PrDescriptionPreview {
  readonly proposalId: string;
  readonly expiresAt: string;
  readonly status: PrDescriptionApplicationStatus;
  readonly finalBody: string;
  readonly managedRegion: string;
  readonly concurrencyLimitation: string;
}
export type PrDescriptionApplicationResult =
  | { readonly outcome: "preview"; readonly preview: PrDescriptionPreview }
  | { readonly outcome: "observed"; readonly status: PrDescriptionApplicationStatus }
  | { readonly outcome: "blocked"; readonly reason: PrDescriptionApplicationReason };
export interface PrDescriptionServiceOptions {
  readonly context: () => PrDescriptionContext | undefined;
  readonly snapshots: GitChangeSnapshotService;
  readonly generation: Omit<
    PrDescription.PrDescriptionDeps,
    "resolveSnapshot" | "revalidateAuthority"
  >;
  readonly adapter: (context: PrDescriptionContext) => GitPullRequestBodyAdapter | undefined;
  readonly mutationDeps: GitDeliveryMutationDeps;
  readonly execution: GitDeliveryPullRequestSeams;
  /** Existing durable delivery owner validates current authority/revision and retains only this receipt. */
  readonly recordStatus: (
    context: PrDescriptionContext,
    status: PrDescriptionApplicationStatus,
  ) => boolean;
  readonly readStatus: (
    context: PrDescriptionContext,
  ) => PrDescriptionApplicationStatus | undefined;
}
export interface PreparedPrDescription {
  readonly context: PrDescriptionContext;
  readonly captureInput: GitChangeSnapshotCaptureInput;
  readonly snapshotReference: string;
  readonly artifact: PrDescriptionArtifact;
  readonly previous: GitPrBody;
  readonly review: PrDescriptionPreview;
  readonly approvalBinding: GitDeliveryApprovalBinding;
  approval?: GitDeliveryApprovalClaim;
}
export interface PrDescriptionApplicationService {
  preview(request: unknown): Promise<PrDescriptionApplicationResult>;
  /** Holds an already-generated Chat artifact as the exact proposal; never calls the model. */
  previewArtifact(artifact: PrDescriptionArtifact): Promise<PrDescriptionApplicationResult>;
  review(proposalId: string): PrDescriptionPreview | undefined;
  issueApproval(proposalId: string): GitDeliveryIssuedApproval | undefined;
  matchesApproval(proposalId: string): boolean;
  consumeApproval(proposalId: string): object | undefined;
  executeApproved(
    proposalId: string,
    lease: object,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal },
  ): Promise<PrDescriptionApplicationResult>;
  reconcile(): Promise<PrDescriptionApplicationResult>;
  invalidate(): void;
}
export class PrDescriptionFailure extends Error {
  public constructor(
    public readonly reason: PrDescriptionApplicationReason,
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "PrDescriptionFailure";
  }
}
