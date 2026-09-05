import type { CodingRuntimeHost } from "./codingRuntimeControlPlane.js";

export type CodingRuntimeTaskOutcome = "cancelled" | "failed" | "succeeded";

export type CodingRuntimeTaskDispatchResult =
  | { readonly ok: true; readonly completion: Promise<CodingRuntimeTaskOutcome> }
  | { readonly ok: false };

export interface CodingRuntimeRunOperation {
  readonly runId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}

export interface CodingRuntimeTaskDispatchRequest extends CodingRuntimeRunOperation {
  readonly taskIntent: string;
  /** Transient server-owned context; never user intent, persistence or skill authorization. */
  readonly initialContext?: string | undefined;
}

export interface CodingRuntimeTaskDispatcher {
  readonly dispatch: (
    request: CodingRuntimeTaskDispatchRequest,
  ) => Promise<CodingRuntimeTaskDispatchResult>;
  readonly abort: (request: CodingRuntimeRunOperation) => Promise<boolean>;
}

export interface QualifiedProductionCodingRuntime extends Omit<
  CodingRuntimeHost,
  "launchResolver"
> {
  readonly mintLaunch: CodingRuntimeHost["launchResolver"];
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
}

export interface ProductionCodingRuntimeResolver {
  /** Returns a qualified server-owned runtime composition or no capability. */
  readonly resolve: () => QualifiedProductionCodingRuntime | undefined;
}

export interface ProductionCodingRuntimeHost extends CodingRuntimeHost {
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
}

/** A missing, throwing, or unqualified production resolver never creates a runtime host. */
export function createProductionCodingRuntimeHost(
  resolver?: ProductionCodingRuntimeResolver,
): ProductionCodingRuntimeHost | undefined {
  if (resolver === undefined) return undefined;
  let runtime: QualifiedProductionCodingRuntime | undefined;
  try {
    runtime = resolver.resolve();
  } catch {
    return undefined;
  }
  if (runtime === undefined) return undefined;
  return {
    createManager: runtime.createManager,
    launchResolver: runtime.mintLaunch,
    approvalAuthority: runtime.approvalAuthority,
    taskDispatcher: runtime.taskDispatcher,
    ...runtimeInteractionPorts(runtime),
    ...(runtime.safeActivityProjection
      ? { safeActivityProjection: runtime.safeActivityProjection }
      : {}),
    ...(runtime.researchGrants ? { researchGrants: runtime.researchGrants } : {}),
    ...(runtime.pendingResearchApprovals
      ? { pendingResearchApprovals: runtime.pendingResearchApprovals }
      : {}),
    cancellationRegistry: runtime.cancellationRegistry,
    ...(runtime.runtimeCapabilityAuthenticator
      ? { runtimeCapabilityAuthenticator: runtime.runtimeCapabilityAuthenticator }
      : {}),
    ...(runtime.gitDeliveryAuthority ? { gitDeliveryAuthority: runtime.gitDeliveryAuthority } : {}),
    ...(runtime.openCodeGatewayReadinessRegistry
      ? { openCodeGatewayReadinessRegistry: runtime.openCodeGatewayReadinessRegistry }
      : {}),
  };
}

function runtimeInteractionPorts(
  runtime: QualifiedProductionCodingRuntime,
): Pick<ProductionCodingRuntimeHost, "permissionPort" | "questionPort"> {
  return {
    ...(runtime.questionPort ? { questionPort: runtime.questionPort } : {}),
    ...(runtime.permissionPort ? { permissionPort: runtime.permissionPort } : {}),
  };
}
