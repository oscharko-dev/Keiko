import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import {
  createCodingRuntimeOrchestrator,
  type CodingRuntimeApprovalAuthority,
  type CodingRuntimeLaunchResolver,
  type CodingRuntimeOrchestrator,
} from "./codingRuntimeOrchestrator.js";
import type { ResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";

export interface CodingRuntimeHost {
  readonly createManager: (
    onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  ) => CodingRuntimeManager;
  readonly launchResolver: CodingRuntimeLaunchResolver;
  readonly approvalAuthority: CodingRuntimeApprovalAuthority;
  readonly taskDispatcher?: CodingRuntimeTaskDispatcher | undefined;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  // Server-level registry of read-only research grants (#2387). Present once the runtime host is
  // composed; the orchestrator reads it to project the live grant on the snapshot and to revoke it.
  readonly researchGrants?: ResearchGrantRegistry | undefined;
  readonly cancellationRegistry: {
    readonly signalFor: (runId: string) => AbortSignal | undefined;
  };
  readonly runtimeCapabilityAuthenticator?:
    | {
        readonly authenticate: (
          capability: string,
          audience: "model-gateway" | "tool-facade",
        ) => unknown;
      }
    | undefined;
  readonly openCodeGatewayReadinessRegistry?:
    | {
        readonly claim: (runId: string) => boolean;
        readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
        readonly clear: (runId: string) => void;
      }
    | undefined;
}

export interface CodingRuntimeControlPlaneInput {
  readonly snapshots: CodingRuntimeSnapshotStore;
  readonly evidence: CodingRuntimeEvidenceAggregator;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly serverPrincipal: () => string | undefined;
  /** Qualified adapters are supplied by #2258; absence is a deliberate unavailable posture. */
  readonly runtimeHost?: CodingRuntimeHost | undefined;
}

export interface CodingRuntimeControlPlane {
  readonly orchestrator: CodingRuntimeOrchestrator;
  readonly eventHub: CodingRuntimeEventHub;
  /** Content-free composition fact: a qualified runtime host was explicitly supplied. */
  readonly runtimeHostQualified: boolean;
  readonly cancellationRegistry?: CodingRuntimeHost["cancellationRegistry"];
  readonly runtimeCapabilityAuthenticator?: CodingRuntimeHost["runtimeCapabilityAuthenticator"];
  readonly openCodeGatewayReadinessRegistry?: CodingRuntimeHost["openCodeGatewayReadinessRegistry"];
}

interface RuntimeEventReceiver {
  ingest?: (event: CodingWorkbenchRuntimeEvent) => void;
}

/**
 * Constructs exactly one process-lifetime runtime aggregate. An unqualified host still exposes the
 * lifecycle/status API, but start fails before minting launch material or touching a process.
 */
// eslint-disable-next-line complexity -- process-lifetime authority composition is intentionally explicit.
export function createCodingRuntimeControlPlane(
  input: CodingRuntimeControlPlaneInput,
): CodingRuntimeControlPlane {
  const eventHub = new CodingRuntimeEventHub();
  const receiver: RuntimeEventReceiver = {};
  const manager =
    input.runtimeHost?.createManager((event) => {
      receiver.ingest?.(event);
    }) ?? unavailableManager();
  const launchResolver = input.runtimeHost?.launchResolver ?? unavailableLaunchResolver();
  const approvalAuthority = input.runtimeHost?.approvalAuthority ?? unavailableApprovalAuthority();
  const orchestrator = createCodingRuntimeOrchestrator({
    manager,
    approvalAuthority,
    eventHub,
    snapshots: input.snapshots,
    evidence: input.evidence,
    workspaceLifecycle: input.workspaceLifecycle,
    launchResolver,
    taskDispatcher: input.runtimeHost?.taskDispatcher ?? unavailableTaskDispatcher(),
    questionPort: input.runtimeHost?.questionPort ?? unavailableQuestionPort(),
    serverPrincipal: input.serverPrincipal,
  });
  receiver.ingest = (event: CodingWorkbenchRuntimeEvent): void => {
    void orchestrator.ingest(event);
  };
  orchestrator.startupReconcileNow();
  return {
    orchestrator,
    eventHub,
    runtimeHostQualified: input.runtimeHost !== undefined,
    ...runtimeHostCapabilities(input.runtimeHost),
  };
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

function runtimeHostCapabilities(
  runtimeHost: CodingRuntimeHost | undefined,
): Pick<
  CodingRuntimeControlPlane,
  "cancellationRegistry" | "runtimeCapabilityAuthenticator" | "openCodeGatewayReadinessRegistry"
> {
  return {
    ...(runtimeHost?.cancellationRegistry
      ? { cancellationRegistry: runtimeHost.cancellationRegistry }
      : {}),
    ...(runtimeHost?.runtimeCapabilityAuthenticator
      ? { runtimeCapabilityAuthenticator: runtimeHost.runtimeCapabilityAuthenticator }
      : {}),
    ...(runtimeHost?.openCodeGatewayReadinessRegistry
      ? { openCodeGatewayReadinessRegistry: runtimeHost.openCodeGatewayReadinessRegistry }
      : {}),
  };
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
  };
}
