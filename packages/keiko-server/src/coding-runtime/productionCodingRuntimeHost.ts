import type { CodingRuntimeHost } from "./codingRuntimeControlPlane.js";
import type {
  CodingRuntimeRecoveryPort,
  CodingRuntimeTaskDispatcher,
} from "./codingRuntimeOrchestrator.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";

export type {
  CodingRuntimeRecoveryPort,
  CodingRuntimeRecoveryResult,
  CodingRuntimeTaskDispatcher,
  CodingRuntimeTaskDispatchResult,
  CodingRuntimeTaskOutcome,
} from "./codingRuntimeOrchestrator.js";

export interface QualifiedProductionCodingRuntime extends Omit<
  CodingRuntimeHost,
  "launchResolver"
> {
  readonly mintLaunch: CodingRuntimeHost["launchResolver"];
  readonly recovery: CodingRuntimeRecoveryPort;
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
}

export interface ProductionCodingRuntimeResolver {
  /** Returns a release-qualified, server-owned runtime composition or no capability. */
  readonly resolve: () => QualifiedProductionCodingRuntime | undefined;
}

export interface ProductionCodingRuntimeHost extends CodingRuntimeHost {
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
  readonly recovery: CodingRuntimeRecoveryPort;
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
  const questionPort = asQuestionPort(runtime.taskDispatcher);
  return {
    createManager: runtime.createManager,
    launchResolver: runtime.mintLaunch,
    approvalAuthority: runtime.approvalAuthority,
    taskDispatcher: runtime.taskDispatcher,
    ...(questionPort ? { questionPort } : {}),
    recovery: runtime.recovery,
    cancellationRegistry: runtime.cancellationRegistry,
    ...(runtime.runtimeCapabilityAuthenticator
      ? { runtimeCapabilityAuthenticator: runtime.runtimeCapabilityAuthenticator }
      : {}),
    ...(runtime.openCodeGatewayReadinessRegistry
      ? { openCodeGatewayReadinessRegistry: runtime.openCodeGatewayReadinessRegistry }
      : {}),
  };
}

function asQuestionPort(
  dispatcher: CodingRuntimeTaskDispatcher,
): CodingRuntimeQuestionPort | undefined {
  const candidate = dispatcher as CodingRuntimeTaskDispatcher & Partial<CodingRuntimeQuestionPort>;
  return typeof candidate.list === "function" &&
    typeof candidate.answer === "function" &&
    typeof candidate.reject === "function"
    ? (candidate as CodingRuntimeTaskDispatcher & CodingRuntimeQuestionPort)
    : undefined;
}
