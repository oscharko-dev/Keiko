import type { CodingWorkbenchAgent } from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeHost } from "./codingRuntimeControlPlane.js";

export type CodingRuntimeTaskOutcome = "cancelled" | "failed" | "succeeded";

export type CodingRuntimeTaskDispatchResult =
  | { readonly ok: true; readonly completion: Promise<CodingRuntimeTaskOutcome> }
  | {
      readonly ok: false;
      /**
       * The closed cause when the refusal is the request's own and not a transport or authority
       * failure: the run's runtime cannot honour the requested primary agent (#3897). Absent for
       * every other refusal, which keeps its existing answer.
       */
      readonly reason?: "agent-unsupported" | undefined;
    };

export interface CodingRuntimeRunOperation {
  readonly runId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}

export interface CodingRuntimeTaskDispatchRequest extends CodingRuntimeRunOperation {
  readonly taskIntent: string;
  /** Request-scoped diagnostic join; never persisted or forwarded to the model. */
  readonly correlationId?: string | undefined;
  /** Transient server-owned context; never user intent, persistence or skill authorization. */
  readonly initialContext?: string | undefined;
  /**
   * The primary agent the turn runs under. Absent keeps the run's current agent (the default
   * `build` for a run that never named one), exactly as before.
   */
  readonly agent?: CodingWorkbenchAgent | undefined;
}

export interface CodingRuntimeTaskDispatcher {
  readonly dispatch: (
    request: CodingRuntimeTaskDispatchRequest,
  ) => Promise<CodingRuntimeTaskDispatchResult>;
  /** Replaces one operator-paused turn after interrupting it at the native adapter boundary. */
  readonly replace?:
    | ((request: CodingRuntimeTaskDispatchRequest) => Promise<CodingRuntimeTaskDispatchResult>)
    | undefined;
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
    cancellationRegistry: runtime.cancellationRegistry,
    ...runtimeInteractionPorts(runtime),
    ...optionalRuntimeCapabilities(runtime),
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

// Every one of these is an OPTIONAL pass-through: present on `QualifiedProductionCodingRuntime`
// only when the resolver supplied it, forwarded onto `ProductionCodingRuntimeHost` unchanged. A
// per-field ternary here would grow `createProductionCodingRuntimeHost`'s cyclomatic complexity by
// one per capability (AGENTS.md §6's complexity <=10 ceiling), so the ONE decision — "was it
// supplied?" — is a single loop over the closed key list instead of N branches.
const OPTIONAL_RUNTIME_CAPABILITY_KEYS = [
  "safeActivityProjection",
  "researchGrants",
  "approvedSkills",
  "pendingResearchApprovals",
  "runtimeCapabilityAuthenticator",
  "gitDeliveryAuthority",
  "gitDeliveryDescriptionAuthority",
  "mintDescriptionAuthority",
  "attachVerifiedHeadNotifier",
  "attachEditOutcomeObserver",
  "attachRepositorySemanticSearch",
  "openCodeGatewayReadinessRegistry",
  "toolFacadeBridge",
  "contextUsage",
  "secureWorkspaceTextRead",
  "runEffort",
  "promptAllowanceExhausted",
  "envelopeDurationExhausted",
] as const;

type OptionalRuntimeCapabilities = Pick<
  ProductionCodingRuntimeHost,
  (typeof OPTIONAL_RUNTIME_CAPABILITY_KEYS)[number]
>;

function optionalRuntimeCapabilities(
  runtime: QualifiedProductionCodingRuntime,
): OptionalRuntimeCapabilities {
  const capabilities: Partial<OptionalRuntimeCapabilities> = {};
  for (const key of OPTIONAL_RUNTIME_CAPABILITY_KEYS) {
    const value = runtime[key];
    if (value !== undefined) Object.assign(capabilities, { [key]: value });
  }
  return capabilities;
}
