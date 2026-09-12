import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeQuestionsResponse,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeStartRequest,
  SkillDiscoveryResultV1,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type {
  CodingRuntimeApprovalIssueRequest,
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeLaunchRequest,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import type { CodingRuntimePermissionPort } from "./codingRuntimePermissionPort.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingSafeActivityProjection } from "./codingSafeActivityProjection.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import type { PendingResearchApprovals } from "./researchApprovalIssuance.js";
import type { ResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { CodingRuntimeIssueIntake } from "./codingRuntimeIssueIntake.js";

export interface CodingRuntimeLaunchResolver {
  /** Bounded server-only reads before the existing start-confirmation claim is consumed. */
  readonly prepare?: (
    input: Parameters<CodingRuntimeLaunchResolver["resolve"]>[0],
  ) => Promise<void>;
  /** Resolves server-only launch material; the intent remains transient and must not be persisted. */
  resolve(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly taskIntent: string;
    readonly requestedMode: CodingWorkbenchRuntimeStartRequest["requestedMode"];
    readonly runtimePreference?: CodingWorkbenchRuntimeStartRequest["runtimePreference"];
    readonly modelId?: CodingWorkbenchRuntimeStartRequest["modelId"];
    readonly reasoningEffort?: CodingWorkbenchRuntimeStartRequest["reasoningEffort"];
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly serverPrincipal: string;
    readonly issueBinding?: CodingWorkbenchIssueBinding | undefined;
  }): Omit<CodingRuntimeLaunchRequest, "runId" | "taskRef" | "workspaceRoot" | "requestedMode"> & {
    readonly taskRef: string;
  };
}

export interface CodingRuntimeApprovalAuthority {
  readonly issue: (request: CodingRuntimeApprovalIssueRequest) => CodingRuntimeApprovalIssueResult;
}

export interface CodingRuntimeOrchestratorDeps {
  readonly manager: CodingRuntimeManager;
  readonly issueIntake?: CodingRuntimeIssueIntake | undefined;
  readonly deploymentCeiling?: CodingWorkbenchRuntimeStartRequest["requestedMode"] | undefined;
  /** Central authority shared with runtime mediation; never a runtime-local approval registry. */
  readonly approvalAuthority: CodingRuntimeApprovalAuthority;
  readonly eventHub: CodingRuntimeEventHub;
  readonly snapshots: CodingRuntimeSnapshotStore;
  readonly evidence: CodingRuntimeEvidenceAggregator;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly launchResolver: CodingRuntimeLaunchResolver;
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
  readonly questionPort: CodingRuntimeQuestionPort;
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
  readonly serverPrincipal: () => string | undefined;
  /**
   * Server-level read-only research grant registry (#2387). The grant is exposed only through the
   * authenticated research channel and the revoke operation drops it; when the registry is absent
   * (no qualified runtime host), that channel has no grant and revoke fails closed.
   */
  readonly researchGrants?: ResearchGrantRegistry | undefined;
  /**
   * The operator's view of the approved skills of the current run (#3417): every approved skill with
   * the readiness the catalog itself can tell. Absent without a qualified runtime host, and then the
   * skills channel simply carries none.
   */
  readonly approvedSkills?: (() => SkillDiscoveryResultV1) | undefined;
  /**
   * The live #2387 research asks awaiting an operator decision. Read non-consumingly to project the
   * reviewable host and request line onto the AUTHENTICATED research channel; when absent, that
   * channel reports no pending ask and the operator simply sees the content-free approval facts.
   */
  readonly pendingResearchApprovals?: PendingResearchApprovals | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

export type CodingRuntimeOrchestratorResult =
  | { readonly ok: true; readonly snapshot: CodingWorkbenchRuntimeSnapshot }
  | {
      readonly ok: false;
      readonly failureCode: CodingWorkbenchRuntimeFailureCode;
      readonly issueBindingFailure?: CodingWorkbenchIssueBindingFailure;
      // The run id a refused start had already minted (issue admission, launch resolution). The
      // route's refusal line carries it, so the request correlation the operator sees as the support
      // id leads to the run-scoped lines that hold the actual cause; without it the two halves of one
      // failed start shared nothing (2026-09-10: `authority-resolution-failed` under the request id,
      // the git preparation failure under the run id, and no join between them).
      readonly runId?: string | undefined;
    };

export type CodingRuntimeQuestionOperationResult =
  | {
      readonly ok: true;
      readonly snapshot: CodingWorkbenchRuntimeSnapshot;
      readonly questions: CodingWorkbenchRuntimeQuestionsResponse;
    }
  | { readonly ok: false; readonly failureCode: CodingWorkbenchRuntimeFailureCode };
