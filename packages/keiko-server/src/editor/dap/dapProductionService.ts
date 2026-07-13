import type { DebugLifecycleEvidence, EvidenceStore } from "@oscharko-dev/keiko-contracts";
import { createDapEvidenceProjector } from "./dapEvidenceProjector.js";
import { createDapEventBridge, type DapEventBridge } from "./dapEventBridge.js";
import { createDapLifecycleLedger, type DapLifecycleLedger } from "./dapLifecycleLedger.js";
import {
  createProductionDebugCapsuleLauncher,
  type DebugCapsuleLauncherDeps,
} from "./dapNodeCapsuleLauncher.js";
import type { DapAdapterPreflightDeps } from "./dapNodeAdapter.js";
import {
  connectPrivateDapEndpoint,
  createNodeDapPrivateEndpointDeps,
  type DapPrivateEndpointDeps,
} from "./dapPrivateEndpoint.js";
import {
  createDapProcessManager,
  type DapProcessManager,
  type DapProcessStartInput,
} from "./dapProcessManager.js";
import type { DebugCapsulePlanBinding, DebugSpawnEnvelope } from "./debugCapsulePlan.js";
import {
  createProductionDebugLaunchContextResolver,
  createProductionDebugTargetRevalidator,
  type DebugLaunchContextResolverDeps,
} from "./debugLaunchContext.js";
import type { DebugLaunchCatalogDeps } from "./debugLaunchCatalog.js";
import { createDebugLaunchLayer2Validator } from "./debugLaunchPlan.js";
import {
  createDebugSessionRegistry,
  type DebugOutputLimitEvent,
  type DebugSessionRegistry,
} from "./debugSessionRegistry.js";
import {
  createDapAdapterProviderCatalog,
  type DapAdapterProviderCatalog,
} from "./providers/dapAdapterProviders.js";
import { createNodeDebugAdapterSpec } from "./providers/nodeDebugAdapter.js";

export interface NodeDebugAdapterProvisioning {
  readonly executableName: string;
  readonly executableArgs: readonly string[];
  readonly trustedRoots: readonly string[];
  /** Legacy declaration only; the launch plan derives the promoted digest from observed artifacts. */
  readonly provisioningDigest: string;
  readonly envAllowlist?: readonly string[] | undefined;
  readonly fixedEnv?: Readonly<Record<string, string>> | undefined;
}

export interface DapProductionProvisioning {
  readonly adapter: NodeDebugAdapterProvisioning;
  readonly adapterPreflight: (
    identity: DapProcessStartInput["identity"],
  ) => DapAdapterPreflightDeps;
  readonly launchContext: (binding: DebugCapsulePlanBinding) => DebugLaunchContextResolverDeps;
  readonly targetCatalog: (workspaceRealPath: string) => DebugLaunchCatalogDeps;
}

export interface DapProductionServiceDeps {
  readonly provisioning: DapProductionProvisioning;
  readonly evidenceStore: EvidenceStore;
  readonly appendJournal: (
    workspacePartitionKey: string,
    evidence: DebugLifecycleEvidence,
  ) => Promise<void>;
  readonly now: () => number;
  readonly epoch: () => number;
  readonly activationRevision: () => number;
  readonly emitOutputLimit: (event: DebugOutputLimitEvent) => Promise<void> | void;
  readonly endpoint?: DapPrivateEndpointDeps | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly onProjectionFailure?: ((error: unknown) => void) | undefined;
  readonly onRuntimeFailure: (error: unknown) => void;
  readonly expirySweepIntervalMs?: number | undefined;
  readonly shutdownTimeoutMs?: number | undefined;
}

export interface DapProductionService {
  readonly manager: DapProcessManager;
  readonly registry: DebugSessionRegistry;
  readonly lifecycleLedger: DapLifecycleLedger;
  readonly eventBridge: DapEventBridge;
  readonly dispose: () => Promise<void>;
}

export interface DapProductionServiceFactories {
  readonly createEvidenceProjector: typeof createDapEvidenceProjector;
  readonly createEventBridge: typeof createDapEventBridge;
  readonly createLifecycleLedger: typeof createDapLifecycleLedger;
  readonly createRegistry: typeof createDebugSessionRegistry;
  readonly createLayer2Validator: typeof createDebugLaunchLayer2Validator;
  readonly createEndpointDeps: typeof createNodeDapPrivateEndpointDeps;
  readonly createTargetRevalidator: typeof createProductionDebugTargetRevalidator;
  readonly createLaunchContextResolver: typeof createProductionDebugLaunchContextResolver;
  readonly createLauncher: typeof createProductionDebugCapsuleLauncher;
  readonly connectEndpoint: typeof connectPrivateDapEndpoint;
  readonly createManager: typeof createDapProcessManager;
  readonly createAdapterCatalog: typeof createDapAdapterProviderCatalog;
  readonly createNodeAdapterSpec: typeof createNodeDebugAdapterSpec;
}

const PRODUCTION_FACTORIES: DapProductionServiceFactories = Object.freeze({
  createEvidenceProjector: createDapEvidenceProjector,
  createEventBridge: createDapEventBridge,
  createLifecycleLedger: createDapLifecycleLedger,
  createRegistry: createDebugSessionRegistry,
  createLayer2Validator: createDebugLaunchLayer2Validator,
  createEndpointDeps: createNodeDapPrivateEndpointDeps,
  createTargetRevalidator: createProductionDebugTargetRevalidator,
  createLaunchContextResolver: createProductionDebugLaunchContextResolver,
  createLauncher: createProductionDebugCapsuleLauncher,
  connectEndpoint: connectPrivateDapEndpoint,
  createManager: createDapProcessManager,
  createAdapterCatalog: createDapAdapterProviderCatalog,
  createNodeAdapterSpec: createNodeDebugAdapterSpec,
});

function adapterCatalog(
  provisioning: NodeDebugAdapterProvisioning,
  factories: DapProductionServiceFactories,
): DapAdapterProviderCatalog {
  return factories.createAdapterCatalog([
    factories.createNodeAdapterSpec(
      provisioning.executableName,
      provisioning.executableArgs,
      provisioning.trustedRoots,
      provisioning.provisioningDigest,
      provisioning.envAllowlist,
      provisioning.fixedEnv,
    ),
  ]);
}

function productionTargetRevalidator(
  provisioning: DapProductionProvisioning,
  factories: DapProductionServiceFactories,
): (envelope: DebugSpawnEnvelope) => boolean {
  return (envelope): boolean =>
    factories.createTargetRevalidator(
      provisioning.targetCatalog(envelope.workspaceIdentity.realPath),
    )(envelope);
}

function launcherDeps(
  deps: DapProductionServiceDeps,
  revalidateTarget: (envelope: DebugSpawnEnvelope) => boolean,
): DebugCapsuleLauncherDeps {
  return {
    now: deps.now,
    epoch: deps.epoch,
    activationRevision: deps.activationRevision,
    platform: deps.platform,
    revalidateTarget,
  };
}

function composeDapProductionService(
  deps: DapProductionServiceDeps,
  factories: DapProductionServiceFactories,
): DapProductionService {
  const projector = factories.createEvidenceProjector(deps.evidenceStore);
  const eventBridge = factories.createEventBridge();
  const lifecycleLedger = factories.createLifecycleLedger({
    appendJournal: deps.appendJournal,
    projectLive: (partition, projection) => projector.project(partition, projection),
    onProjectionFailure: deps.onProjectionFailure,
  });
  const registry = factories.createRegistry({
    appendEvidence: (partition, evidence) =>
      lifecycleLedger.append(partition, evidence).then(() => undefined),
    now: deps.now,
    emitOutputLimit: deps.emitOutputLimit,
  });
  const validateCapsulePlan = factories.createLayer2Validator({
    now: deps.now,
    epoch: deps.epoch,
    resolveContext: (input) =>
      factories.createLaunchContextResolver(deps.provisioning.launchContext(input.binding))(input),
  });
  const endpoint = deps.endpoint ?? factories.createEndpointDeps();
  const revalidateTarget = productionTargetRevalidator(deps.provisioning, factories);
  const manager = factories.createManager({
    registry,
    adapterCatalog: adapterCatalog(deps.provisioning.adapter, factories),
    adapterPreflight: deps.provisioning.adapterPreflight,
    validateCapsulePlan,
    launchCapsule: factories.createLauncher(launcherDeps(deps, revalidateTarget)),
    connectEndpoint: (plan) => factories.connectEndpoint(plan, endpoint),
    revalidateTarget,
    events: eventBridge,
  });
  const dispose = createDapServiceDisposer(manager, eventBridge, deps);
  return Object.freeze({ manager, registry, lifecycleLedger, eventBridge, dispose });
}

function createDapServiceDisposer(
  manager: DapProcessManager,
  eventBridge: DapEventBridge,
  deps: DapProductionServiceDeps,
): () => Promise<void> {
  let sweep: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (sweep !== undefined) return;
    sweep = manager
      .sweepExpired()
      .then(() => manager.reconcile())
      .catch((error: unknown) => {
        deps.onRuntimeFailure(error);
      })
      .finally(() => {
        sweep = undefined;
      });
  }, deps.expirySweepIntervalMs ?? 1_000);
  timer.unref();
  return (): Promise<void> => {
    disposePromise ??= disposeDapService(timer, () => sweep, manager, eventBridge, deps);
    return disposePromise;
  };
}

function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("DAP_SHUTDOWN_TIMEOUT"));
    }, timeoutMs);
    timer.unref();
    operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("DAP_SHUTDOWN_FAILED"));
      },
    );
  });
}

async function disposeDapService(
  timer: ReturnType<typeof setInterval>,
  activeSweep: () => Promise<void> | undefined,
  manager: DapProcessManager,
  eventBridge: DapEventBridge,
  deps: DapProductionServiceDeps,
): Promise<void> {
  clearInterval(timer);
  try {
    await withTimeout(
      (async (): Promise<void> => {
        await activeSweep();
        await manager.shutdown();
      })(),
      deps.shutdownTimeoutMs ?? 5_000,
    );
  } catch (error: unknown) {
    deps.onRuntimeFailure(error);
  } finally {
    eventBridge.disposeAll();
  }
}

export function createDapProductionService(deps: DapProductionServiceDeps): DapProductionService {
  return composeDapProductionService(deps, PRODUCTION_FACTORIES);
}

export const dapProductionServiceTestBoundary = Object.freeze({
  compose: composeDapProductionService,
  productionFactories: PRODUCTION_FACTORIES,
});
