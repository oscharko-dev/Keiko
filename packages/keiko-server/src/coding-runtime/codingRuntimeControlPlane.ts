import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import {
  createCodingRuntimeOrchestrator,
  type CodingRuntimeApprovalAuthority,
  type CodingRuntimeLaunchResolver,
  type CodingRuntimeOrchestrator,
  type CodingRuntimeRecoveryPort,
  type CodingRuntimeTaskDispatcher,
} from "./codingRuntimeOrchestrator.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

export interface CodingRuntimeHost {
  readonly createManager: (
    onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  ) => CodingRuntimeManager;
  readonly launchResolver: CodingRuntimeLaunchResolver;
  readonly approvalAuthority: CodingRuntimeApprovalAuthority;
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
  readonly recovery: CodingRuntimeRecoveryPort;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
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
  readonly startupRecovery: Promise<void>;
  readonly quiescence: { readonly isQuiescent: () => boolean };
  readonly cancellationRegistry?: CodingRuntimeHost["cancellationRegistry"];
  readonly runtimeCapabilityAuthenticator?: CodingRuntimeHost["runtimeCapabilityAuthenticator"];
  readonly openCodeGatewayReadinessRegistry?: CodingRuntimeHost["openCodeGatewayReadinessRegistry"];
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
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
  const eventHub = new CodingRuntimeEventHub();
  const receiver: RuntimeEventReceiver = {};
  const manager = createManager(input.runtimeHost, receiver);
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
    recovery: input.runtimeHost?.recovery ?? unavailableRecoveryPort(),
    serverPrincipal: input.serverPrincipal,
  });
  receiver.ingest = (event: CodingWorkbenchRuntimeEvent): void => {
    void orchestrator.ingest(event);
  };
  orchestrator.startupReconcileNow();
  const startupRecovery = orchestrator.reconcileStartupRecovery();
  return {
    orchestrator,
    eventHub,
    runtimeHostQualified: input.runtimeHost !== undefined,
    startupRecovery,
    quiescence: { isQuiescent: () => orchestrator.status().state === "idle" },
    ...runtimeHostQuestionPort(input.runtimeHost),
    ...runtimeHostCapabilities(input.runtimeHost),
  };
}

function runtimeHostQuestionPort(
  runtimeHost: CodingRuntimeHost | undefined,
): Pick<CodingRuntimeControlPlane, "questionPort"> {
  return runtimeHost?.questionPort ? { questionPort: runtimeHost.questionPort } : {};
}

function createManager(
  runtimeHost: CodingRuntimeHost | undefined,
  receiver: RuntimeEventReceiver,
): CodingRuntimeManager {
  return (
    runtimeHost?.createManager((event) => {
      receiver.ingest?.(event);
    }) ?? unavailableManager()
  );
}

function unavailableTaskDispatcher(): CodingRuntimeTaskDispatcher {
  return {
    dispatch: () => Promise.resolve({ ok: false }),
    abort: () => Promise.resolve(false),
  };
}

function unavailableRecoveryPort(): CodingRuntimeRecoveryPort {
  return { reconcile: () => Promise.resolve({ status: "unreaped" }) };
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
    stop: stopped,
    takeover: stopped,
    reconcile: stopped,
    health: () => ({ status: "stopped" }),
  };
}
