import type {
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeQuestionsResponse,
  CodingWorkbenchRuntimeSnapshot,
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
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";

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
  };
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
  readonly questionPort: CodingRuntimeQuestionPort;
  readonly serverPrincipal: () => string | undefined;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

export type CodingRuntimeOrchestratorResult =
  | { readonly ok: true; readonly snapshot: CodingWorkbenchRuntimeSnapshot }
  | { readonly ok: false; readonly failureCode: CodingWorkbenchRuntimeFailureCode };

export type CodingRuntimeQuestionOperationResult =
  | {
      readonly ok: true;
      readonly snapshot: CodingWorkbenchRuntimeSnapshot;
      readonly questions: CodingWorkbenchRuntimeQuestionsResponse;
    }
  | { readonly ok: false; readonly failureCode: CodingWorkbenchRuntimeFailureCode };
