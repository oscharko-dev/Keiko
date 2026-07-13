import type {
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  CodingWorkbenchRuntimeStartRequest,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type {
  CodingRuntimeApprovalIssueRequest,
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeLaunchRequest,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

export interface CodingRuntimeLaunchResolver {
  /** Resolves server-only launch material; the intent remains transient and must not be persisted. */
  resolve(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly taskIntent: string;
    readonly requestedMode: CodingWorkbenchRuntimeStartRequest["requestedMode"];
    readonly runtimePreference?: CodingWorkbenchRuntimeStartRequest["runtimePreference"];
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly serverPrincipal: string;
  }): Omit<CodingRuntimeLaunchRequest, "runId" | "taskRef" | "workspaceRoot" | "requestedMode"> & {
    readonly taskRef: string;
    readonly recoveryHandle: string;
  };
}

export type CodingRuntimeTaskOutcome = "cancelled" | "failed" | "succeeded";
export type CodingRuntimeTaskDispatchResult =
  | { readonly ok: true; readonly completion: Promise<CodingRuntimeTaskOutcome> }
  | { readonly ok: false };

export interface CodingRuntimeTaskDispatcher {
  readonly dispatch: (
    runId: string,
    taskIntent: string,
  ) => Promise<CodingRuntimeTaskDispatchResult>;
  readonly abort: (runId: string) => Promise<boolean>;
}

export type CodingRuntimeRecoveryResult =
  { readonly status: "reaped"; readonly recoveryHandle: string } | { readonly status: "unreaped" };

export interface CodingRuntimeRecoveryPort {
  readonly reconcile: (
    runId: string,
    recoveryHandle: string,
  ) => Promise<CodingRuntimeRecoveryResult>;
}

export interface CodingRuntimeApprovalAuthority {
  readonly issue: (request: CodingRuntimeApprovalIssueRequest) => CodingRuntimeApprovalIssueResult;
}

export interface CodingRuntimeOrchestratorDeps {
  readonly manager: CodingRuntimeManager;
  /** Central authority shared with runtime mediation; never a runtime-local approval registry. */
  readonly approvalAuthority: CodingRuntimeApprovalAuthority;
  readonly eventHub: CodingRuntimeEventHub;
  readonly snapshots: CodingRuntimeSnapshotStore;
  readonly evidence: CodingRuntimeEvidenceAggregator;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly launchResolver: CodingRuntimeLaunchResolver;
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
  readonly recovery: CodingRuntimeRecoveryPort;
  readonly serverPrincipal: () => string | undefined;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

export type CodingRuntimeOrchestratorResult =
  | { readonly ok: true; readonly snapshot: PublicSnapshot }
  | { readonly ok: false; readonly failureCode: CodingWorkbenchRuntimeFailureCode };

export interface ApprovalChallenge {
  readonly revision: number;
  readonly expiresAt: number;
  readonly permission: CodingWorkbenchRuntimePendingPermission;
  used: boolean;
}
