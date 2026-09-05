import type {
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type {
  GitDeliveryDescriptionAuthorityPort,
  GitDeliveryDescriptionAuthorityScope,
  GitDeliveryRunAuthorityPort,
} from "../gitDelivery/runBoundAuthority.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import {
  createCodingRuntimeOrchestrator,
  type CodingRuntimeApprovalAuthority,
  type CodingRuntimeLaunchResolver,
  type CodingRuntimeOrchestrator,
} from "./codingRuntimeOrchestrator.js";
import type { PendingResearchApprovals } from "./researchApprovalIssuance.js";
import type { ResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import type { CodingRuntimePermissionPort } from "./codingRuntimePermissionPort.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingSafeActivityProjection } from "./codingSafeActivityProjection.js";
import type { CodingRuntimeIssueIntake } from "./codingRuntimeIssueIntake.js";

export interface CodingRuntimeHost {
  readonly createManager: (
    onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  ) => CodingRuntimeManager;
  readonly launchResolver: CodingRuntimeLaunchResolver;
  readonly approvalAuthority: CodingRuntimeApprovalAuthority;
  readonly taskDispatcher?: CodingRuntimeTaskDispatcher | undefined;
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  // Server-level registry of read-only research grants (#2387). Present once the runtime host is
  // composed; the orchestrator reads it to project the live grant on the snapshot and to revoke it.
  readonly researchGrants?: ResearchGrantRegistry | undefined;
  // Live #2387 research asks awaiting a decision. Present once the runtime host is composed; the
  // orchestrator reads it non-consumingly to project the reviewable host and request line onto the
  // authenticated research channel so the operator can see what they are approving.
  readonly pendingResearchApprovals?: PendingResearchApprovals | undefined;
  readonly cancellationRegistry: {
    readonly signalFor: (runId: string) => AbortSignal | undefined;
  };
  readonly runtimeCapabilityAuthenticator?:
    | {
        readonly authenticate: (
          capability: string,
          audience: "model-gateway" | "tool-facade",
        ) => unknown;
        readonly reservePromptTokens?:
          ((capability: string, promptTokens: number) => unknown) | undefined;
      }
    | undefined;
  /** Live server-private delivery authority for the currently accepted runtime run. */
  readonly gitDeliveryAuthority?: GitDeliveryRunAuthorityPort | undefined;
  // #3399 (epic #3384 correction 4): the server-minted, bounded description authority that admits
  // description generation and the "pull-request" body-only apply outside a running Code task —
  // threaded through the exact same chain as `gitDeliveryAuthority` above.
  readonly gitDeliveryDescriptionAuthority?: GitDeliveryDescriptionAuthorityPort | undefined;
  // #3401 (epic #3384 closeout, description-composition-closeout): the MINT half of the
  // description authority above. Consumed by deps.ts's `attachWorkbenchDescriptionSupport` so the
  // automatic-description dispatcher can mint a scope before checking it, exactly the way the
  // Chat-turn admission check and the pull-request route already only READ.
  readonly mintDescriptionAuthority?:
    ((scope: GitDeliveryDescriptionAuthorityScope, nowIso: string) => void) | undefined;
  // #3401 CI-repair notify: called exactly once, right after this control plane builds its
  // orchestrator, so a per-run CI-repair controller minted deep inside the runtime resolver (long
  // before the orchestrator exists) can still reach `CodingRuntimeOrchestrator
  // .notifyVerifiedHeadAdvanced` once it does. Consumed internally by
  // `createCodingRuntimeControlPlane` below -- never forwarded past this module.
  readonly attachVerifiedHeadNotifier?: ((notify: (runId: string) => void) => void) | undefined;
  readonly openCodeGatewayReadinessRegistry?:
    | {
        readonly claim: (runId: string) => boolean;
        readonly isVerified: (runId: string) => boolean;
        readonly verifyObserved: (runId: string) => void;
        readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
        readonly noteAdoptionGapDiagnosed: (runId: string) => boolean;
        readonly clear: (runId: string, preserveVerification?: boolean) => void;
      }
    | undefined;
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
}

export interface CodingRuntimeControlPlaneInput {
  readonly issueIntake?: CodingRuntimeIssueIntake | undefined;
  readonly deploymentCeiling?: CodingWorkbenchMode | undefined;
  readonly snapshots: CodingRuntimeSnapshotStore;
  readonly evidence: CodingRuntimeEvidenceAggregator;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly serverPrincipal: () => string | undefined;
  /** Qualified adapters are supplied by #2258; absence is a deliberate unavailable posture. */
  readonly runtimeHost?: CodingRuntimeHost | undefined;
  /**
   * When present, mid-stream SSE fan-out write failures are recorded via this sink — one
   * redacted record per subscriber, correlationId=runId (KEIKO-0225).
   */
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
}

export interface CodingRuntimeControlPlane {
  readonly orchestrator: CodingRuntimeOrchestrator;
  readonly eventHub: CodingRuntimeEventHub;
  /** Content-free composition fact: a qualified runtime host was explicitly supplied. */
  readonly runtimeHostQualified: boolean;
  readonly cancellationRegistry?: CodingRuntimeHost["cancellationRegistry"];
  readonly runtimeCapabilityAuthenticator?: CodingRuntimeHost["runtimeCapabilityAuthenticator"];
  readonly gitDeliveryAuthority?: CodingRuntimeHost["gitDeliveryAuthority"];
  readonly gitDeliveryDescriptionAuthority?: CodingRuntimeHost["gitDeliveryDescriptionAuthority"];
  readonly mintDescriptionAuthority?: CodingRuntimeHost["mintDescriptionAuthority"];
  readonly openCodeGatewayReadinessRegistry?: CodingRuntimeHost["openCodeGatewayReadinessRegistry"];
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
}

interface RuntimeEventReceiver {
  ingest?: (event: CodingWorkbenchRuntimeEvent) => void;
}

/**
 * Constructs exactly one process-lifetime runtime aggregate. An unqualified host still exposes the
 * lifecycle/status API, but start fails before minting launch material or touching a process.
 */
export function createCodingRuntimeControlPlane(
  input: CodingRuntimeControlPlaneInput,
): CodingRuntimeControlPlane {
  const eventHub = new CodingRuntimeEventHub(
    input.diagnostics ? { diagnostics: input.diagnostics } : {},
  );
  const receiver: RuntimeEventReceiver = {};
  const manager =
    input.runtimeHost?.createManager((event) => {
      receiver.ingest?.(event);
    }) ?? unavailableManager();
  const launchResolver = input.runtimeHost?.launchResolver ?? unavailableLaunchResolver();
  const approvalAuthority = input.runtimeHost?.approvalAuthority ?? unavailableApprovalAuthority();
  const orchestrator = createControlPlaneOrchestrator(
    input,
    manager,
    approvalAuthority,
    eventHub,
    launchResolver,
  );
  receiver.ingest = (event: CodingWorkbenchRuntimeEvent): void => {
    void orchestrator.ingest(event);
  };
  attachVerifiedHeadNotifier(input.runtimeHost, orchestrator);
  orchestrator.startupReconcileNow();
  return {
    orchestrator,
    eventHub,
    runtimeHostQualified: input.runtimeHost !== undefined,
    ...(input.runtimeHost?.safeActivityProjection
      ? { safeActivityProjection: input.runtimeHost.safeActivityProjection }
      : {}),
    ...runtimeHostCapabilities(input.runtimeHost),
  };
}

// eslint-disable-next-line complexity -- process-lifetime authority composition is intentionally explicit.
function createControlPlaneOrchestrator(
  input: CodingRuntimeControlPlaneInput,
  manager: CodingRuntimeManager,
  approvalAuthority: CodingRuntimeApprovalAuthority,
  eventHub: CodingRuntimeEventHub,
  launchResolver: CodingRuntimeLaunchResolver,
): CodingRuntimeOrchestrator {
  return createCodingRuntimeOrchestrator({
    issueIntake: input.issueIntake,
    deploymentCeiling: input.deploymentCeiling,
    manager,
    approvalAuthority,
    eventHub,
    snapshots: input.snapshots,
    evidence: input.evidence,
    workspaceLifecycle: input.workspaceLifecycle,
    launchResolver,
    taskDispatcher: input.runtimeHost?.taskDispatcher ?? unavailableTaskDispatcher(),
    permissionPort: input.runtimeHost?.permissionPort ?? unavailablePermissionPort(),
    questionPort: input.runtimeHost?.questionPort ?? unavailableQuestionPort(),
    ...(input.runtimeHost?.safeActivityProjection
      ? { safeActivityProjection: input.runtimeHost.safeActivityProjection }
      : {}),
    serverPrincipal: input.serverPrincipal,
    ...(input.runtimeHost?.researchGrants
      ? { researchGrants: input.runtimeHost.researchGrants }
      : {}),
    ...(input.runtimeHost?.pendingResearchApprovals
      ? { pendingResearchApprovals: input.runtimeHost.pendingResearchApprovals }
      : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.activityLog ? { activityLog: input.activityLog } : {}),
  });
}

// #3401: fills the runtime host's notify slot with the orchestrator's real, public
// `notifyVerifiedHeadAdvanced` seam now that it exists -- never a second dispatcher. Extracted so
// `createCodingRuntimeControlPlane` stays under AGENTS.md §6's complexity <=10 ceiling.
function attachVerifiedHeadNotifier(
  runtimeHost: CodingRuntimeHost | undefined,
  orchestrator: CodingRuntimeOrchestrator,
): void {
  runtimeHost?.attachVerifiedHeadNotifier?.((runId: string): void => {
    orchestrator.notifyVerifiedHeadAdvanced(runId);
  });
}

function unavailableTaskDispatcher(): CodingRuntimeTaskDispatcher {
  return {
    dispatch: () => Promise.resolve({ ok: false }),
    abort: () => Promise.resolve(false),
  };
}

function unavailableQuestionPort(): CodingRuntimeQuestionPort {
  return {
    list: () => Promise.resolve(undefined),
    answer: () => Promise.resolve(false),
    reject: () => Promise.resolve(false),
  };
}

function unavailablePermissionPort(): CodingRuntimePermissionPort {
  return { resolve: () => Promise.resolve(false) };
}

// Every one of these is an OPTIONAL pass-through: present on `CodingRuntimeHost` only when the
// production composition supplied it, forwarded onto `CodingRuntimeControlPlane` unchanged. A
// per-field ternary here would grow this function's cyclomatic complexity by one per capability
// (AGENTS.md §6's complexity <=10 ceiling), so the ONE decision — "was it supplied?" — is a single
// loop over the closed key list instead of N branches.
const RUNTIME_HOST_CAPABILITY_KEYS = [
  "cancellationRegistry",
  "runtimeCapabilityAuthenticator",
  "gitDeliveryAuthority",
  "gitDeliveryDescriptionAuthority",
  "mintDescriptionAuthority",
  "openCodeGatewayReadinessRegistry",
] as const;

type RuntimeHostCapabilities = Pick<
  CodingRuntimeControlPlane,
  (typeof RUNTIME_HOST_CAPABILITY_KEYS)[number]
>;

function runtimeHostCapabilities(
  runtimeHost: CodingRuntimeHost | undefined,
): RuntimeHostCapabilities {
  const capabilities: Partial<RuntimeHostCapabilities> = {};
  if (runtimeHost === undefined) return capabilities;
  for (const key of RUNTIME_HOST_CAPABILITY_KEYS) {
    const value = runtimeHost[key];
    if (value !== undefined) Object.assign(capabilities, { [key]: value });
  }
  return capabilities;
}

function unavailableLaunchResolver(): CodingRuntimeLaunchResolver {
  return {
    resolve: (): never => {
      throw new Error("coding-runtime-host-unavailable");
    },
  };
}

function unavailableApprovalAuthority(): CodingRuntimeApprovalAuthority {
  return {
    issue: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
  };
}

function unavailableManager(): CodingRuntimeManager {
  const stopped = (): ReturnType<CodingRuntimeManager["stop"]> =>
    Promise.resolve({ ok: false, failureCode: "runtime-run-mismatch", retryable: false } as const);
  return {
    start: () => ({ ok: false, failureCode: "runtime-unqualified", retryable: false }),
    issueApproval: () => ({
      ok: false,
      failureCode: "runtime-stopped",
      retryable: false,
    }),
    pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    stop: stopped,
    takeover: stopped,
    reconcile: stopped,
    health: () => ({ status: "stopped" }),
    // No qualified runtime host means no run and therefore nothing to review; fail closed.
    pendingApprovalReview: () => undefined,
    result: () => undefined,
  };
}
