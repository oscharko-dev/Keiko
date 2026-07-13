import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  type UpdatePortableTarget,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeIntent,
} from "@oscharko-dev/keiko-contracts";
import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-sandbox";

import { editorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { editorAgentRegistry } from "../editor/agentSessionRegistry.js";
import type { VerificationRunnerManager } from "../editor/verificationRunner.js";
import { createOpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingRuntimeLaunchRequest, CodingRuntimeManager } from "./codingRuntimeManager.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { createNativeRuntimeProcessBackend } from "./nativeRuntimeProcessBackend.js";
import { createOpenCodeRuntimeComposition } from "./opencodeRuntimeComposition.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import type {
  ProductionCodingRuntimeResolver,
  QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";
import {
  createProductionAuthorityLifecycle,
  createProductionRuntimeManager,
  createProductionRuntimeRecoveryPort,
  createProductionRuntimeTaskDispatcher,
  type ProductionRuntimeRunRecord,
} from "./productionOpenCodeRuntimePorts.js";
import {
  discoverQualifiedPortableOpenCode,
  type PortableOpenCodeDiscoveryInput,
  type QualifiedPortableOpenCodeRuntime,
} from "./productionPortableCodingRuntime.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  CodingRuntimeAuthorityService,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessSupervisor,
} from "./runtimeProcessSupervisor.js";
import {
  productionRuntimeAuthorityFacts,
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
} from "./productionRuntimeWorkspaceAuthority.js";

export interface ProductionOpenCodeRuntimeResolverInput {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly managedTaskWorkspaceRoot: string;
  readonly verificationRunner: Pick<VerificationRunnerManager, "runToReport">;
  readonly runtimeStateRoot: string;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly readWorkspaceHead: (workspaceRoot: string, repositoryRoot: string) => string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly portable?: PortableOpenCodeDiscoveryInput | undefined;
  /** Explicit functional-test seam. Production composition never supplies or auto-discovers this. */
  readonly functionalHarness?: ProductionOpenCodeFunctionalHarness | undefined;
}

export interface ProductionOpenCodeFunctionalHarness {
  readonly evidenceClass: "functional-not-platform-qualified";
  /**
   * Functional evidence may exercise a staged macOS artifact, but is never a production discovery
   * result or platform qualification. This type is reachable only through this explicit injection.
   */
  readonly portable: FunctionalPortableOpenCodeRuntime;
  readonly createSupervisor: (input: {
    readonly workspaceRoot: string;
    readonly portable: FunctionalPortableOpenCodeRuntime;
  }) => RuntimeProcessSupervisor;
}

export interface FunctionalPortableOpenCodeRuntime {
  readonly evidenceClass: "functional-not-platform-qualified";
  readonly installRoot: string;
  readonly target: UpdatePortableTarget;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly nativeHelperPath: string;
}

type ResolvedPortableOpenCodeRuntime =
  QualifiedPortableOpenCodeRuntime | FunctionalPortableOpenCodeRuntime;

type MintedRuntimeStart = Extract<
  ReturnType<CodingRuntimeAuthorityService["mintStartForRun"]>,
  { readonly ok: true }
>;

interface RunRecordDependencies {
  readonly input: ProductionOpenCodeRuntimeResolverInput;
  readonly portable: ResolvedPortableOpenCodeRuntime;
  readonly authority: CodingRuntimeAuthorityService;
  readonly readiness: ReturnType<typeof createOpenCodeGatewayReadinessRegistry>;
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntimeStart;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
}

interface RunRecordResources {
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  readonly controller: AbortController;
}

export function createProductionOpenCodeRuntimeResolver(
  input: ProductionOpenCodeRuntimeResolverInput,
): ProductionCodingRuntimeResolver {
  return {
    resolve: () => qualifiedRuntime(input),
  };
}

function qualifiedRuntime(
  input: ProductionOpenCodeRuntimeResolverInput,
): QualifiedProductionCodingRuntime | undefined {
  const portable =
    input.functionalHarness?.portable ??
    discoverQualifiedPortableOpenCode(input.portable ?? { env: input.env });
  if (portable === undefined || !validGatewayPort(input.env.KEIKO_UI_PORT)) return undefined;
  if (!isAbsolute(input.runtimeStateRoot) || !isAbsolute(input.managedTaskWorkspaceRoot)) {
    return undefined;
  }
  return composeQualifiedRuntime(input, portable);
}

function composeQualifiedRuntime(
  input: ProductionOpenCodeRuntimeResolverInput,
  portable: ResolvedPortableOpenCodeRuntime,
): QualifiedProductionCodingRuntime {
  const authority = new CodingRuntimeAuthorityService(editorAgentAuthorityRegistry);
  const readiness = createOpenCodeGatewayReadinessRegistry();
  const runs = new Map<string, ProductionRuntimeRunRecord>();
  let receiver: (event: CodingWorkbenchRuntimeEvent) => void = () => undefined;
  const manager = createProductionRuntimeManager(runs, authority);
  const relay = createProductionRuntimeEventRelay(manager, () => receiver);
  return {
    createManager: (onRuntimeEvent): ReturnType<typeof createProductionRuntimeManager> => {
      receiver = onRuntimeEvent;
      return manager;
    },
    mintLaunch: launchResolver(input, portable, authority, readiness, runs, relay),
    approvalAuthority: { issue: (request) => manager.issueApproval(request) },
    taskDispatcher: createProductionRuntimeTaskDispatcher(runs),
    recovery: input.functionalHarness
      ? functionalRecoveryPort()
      : createProductionRuntimeRecoveryPort(portable),
    cancellationRegistry: { signalFor: (runId) => runs.get(runId)?.controller.signal },
    runtimeCapabilityAuthenticator: {
      authenticate: (capability, audience) =>
        authority.authenticateCapability(capability, audience),
    },
    openCodeGatewayReadinessRegistry: readiness,
  };
}

/** @internal Keeps resolver-owned run cleanup ordered before terminal event visibility. */
export function createProductionRuntimeEventRelay(
  manager: Pick<CodingRuntimeManager, "reconcile">,
  receiver: () => (event: CodingWorkbenchRuntimeEvent) => void,
): (event: CodingWorkbenchRuntimeEvent) => void {
  return (event): void => {
    if (event.kind !== "runtime-stopped") {
      receiver()(event);
      return;
    }
    void forwardSettledRuntimeEvent(manager, receiver, event);
  };
}

async function forwardSettledRuntimeEvent(
  manager: Pick<CodingRuntimeManager, "reconcile">,
  receiver: () => (event: CodingWorkbenchRuntimeEvent) => void,
  event: CodingWorkbenchRuntimeEvent,
): Promise<void> {
  try {
    const result = await manager.reconcile(event.runId);
    receiver()(result.ok ? event : cleanupFailureEvent(event));
  } catch {
    receiver()(cleanupFailureEvent(event));
  }
}

function cleanupFailureEvent(event: CodingWorkbenchRuntimeEvent): CodingWorkbenchRuntimeEvent {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    runId: event.runId,
    occurredAt: event.occurredAt,
    kind: "failure-redacted",
    failureCode: "failure-redacted",
    failureSummary: "runtime-failed",
    retryable: false,
  };
}

/** Functional-only runs have no native helper receipt; recovery remains deliberately unreaped. */
function functionalRecoveryPort(): QualifiedProductionCodingRuntime["recovery"] {
  return { reconcile: () => Promise.resolve({ status: "unreaped" as const }) };
}

function launchResolver(
  input: ProductionOpenCodeRuntimeResolverInput,
  portable: ResolvedPortableOpenCodeRuntime,
  authority: CodingRuntimeAuthorityService,
  readiness: ReturnType<typeof createOpenCodeGatewayReadinessRegistry>,
  runs: Map<string, ProductionRuntimeRunRecord>,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): QualifiedProductionCodingRuntime["mintLaunch"] {
  return {
    resolve: (request): ReturnType<QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]> => {
      if (request.runtimePreference === "codex-subscription") throw new Error("codex-unqualified");
      const context = resolveProductionRuntimeContext(input, request);
      const intent = startIntent(request);
      const nowIso = new Date().toISOString();
      const confirmation = authority.confirmStart(
        intent,
        context.taskId,
        context.operatorId,
        nowIso,
      );
      const minted = authority.mintStartForRun(
        request.runId,
        intent,
        context,
        confirmation,
        nowIso,
      );
      if (!minted.ok) throw new Error(minted.reason);
      const record = createRunRecord({
        input,
        portable,
        authority,
        readiness,
        context,
        minted,
        onRuntimeEvent,
      });
      runs.set(request.runId, record);
      return launchRequest(input, portable, context, minted);
    },
  };
}

function createRunRecord(dependencies: RunRecordDependencies): ProductionRuntimeRunRecord {
  const resources = createRunRecordResources();
  const composition = createRuntimeComposition(dependencies, resources);
  return { context: dependencies.context, composition, ...resources };
}

function createRunRecordResources(): RunRecordResources {
  const invocationRegistry = createCodingToolInvocationRegistry();
  const leases = createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry,
    cancelPendingByAuthorityRun: (runId) => editorAgentRegistry.cancelPendingByAuthorityRun(runId),
  });
  const controller = new AbortController();
  return { invocationRegistry, leases, controller };
}

function createRuntimeComposition(
  dependencies: RunRecordDependencies,
  resources: RunRecordResources,
): ProductionRuntimeRunRecord["composition"] {
  const facade = createManagedWorktreeToolFacade(dependencies, resources);
  const supervisor = runtimeSupervisor(
    dependencies.input,
    dependencies.portable,
    dependencies.context.workspaceRoot,
  );
  return createOpenCodeRuntimeComposition({
    portable: {
      verification: dependencies.portable.sidecar,
      resourceRoot: dependencies.portable.installRoot,
      target: dependencies.portable.target,
    },
    stateBaseRoot: join(dependencies.input.runtimeStateRoot, "coding-runtime", "opencode"),
    capabilities: {
      modelGatewayCapability: dependencies.minted.modelGatewayCapability,
      toolFacadeCapability: dependencies.minted.toolFacadeCapability,
    },
    toolFacade: facade,
    governedEventSink: idempotentEventSink(
      dependencies.minted.authorityRef.runId,
      dependencies.minted.authorityRef.envelopeDigest,
      dependencies.input.runtimeEvidence,
    ),
    gatewayReadiness: dependencies.readiness,
    fetch: dependencies.input.fetch ?? globalThis.fetch,
    supervisor,
    onRuntimeEvent: dependencies.onRuntimeEvent,
    authorityLifecycle: createProductionAuthorityLifecycle(
      dependencies.authority,
      resources.invocationRegistry,
      resources.leases,
      resources.controller,
    ),
  });
}

function createManagedWorktreeToolFacade(
  dependencies: RunRecordDependencies,
  resources: RunRecordResources,
): ReturnType<typeof createProductionManagedWorktreeToolFacade> {
  const liveFacts = (): ReturnType<typeof productionRuntimeAuthorityFacts> =>
    productionRuntimeAuthorityFacts(dependencies.input, dependencies.context);
  const authorityWorkspaceId = liveFacts().binding.workspaceId;
  return createProductionManagedWorktreeToolFacade({
    authority: dependencies.authority,
    authorityRef: dependencies.minted.authorityRef,
    workspaceId: authorityWorkspaceId,
    workspaceRoot: dependencies.context.workspaceRoot,
    authorityExpiresAt: dependencies.context.expiresAt,
    deploymentCeiling: dependencies.context.deploymentCeiling,
    liveFacts,
    assertLiveWorkspace: () => productionWorkspaceMatches(dependencies.input, dependencies.context),
    invocationRegistry: resources.invocationRegistry,
    leases: resources.leases,
    verificationRunner: dependencies.input.verificationRunner,
    onRuntimeEvent: dependencies.onRuntimeEvent,
  });
}

function runtimeSupervisor(
  input: ProductionOpenCodeRuntimeResolverInput,
  portable: ResolvedPortableOpenCodeRuntime,
  workspaceRoot: string,
): RuntimeProcessSupervisor {
  if (input.functionalHarness) {
    return input.functionalHarness.createSupervisor({
      workspaceRoot,
      portable: input.functionalHarness.portable,
    });
  }
  return createRuntimeProcessSupervisor({
    backend: createNativeRuntimeProcessBackend({
      helperPath: portable.nativeHelperPath,
      runtimeRoots: [join(portable.installRoot, portable.sidecar.payloadRootPath)],
      workspaceRoot,
    }),
    qualifications: [portable.qualification],
  });
}

function startIntent(
  request: Parameters<QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]>[0],
): Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }> {
  return {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    requestId: request.requestId,
    command: "start",
    taskIntent: request.taskIntent,
    requestedMode: request.requestedMode,
    modelSource: "keiko-model-gateway",
  };
}

function launchRequest(
  input: ProductionOpenCodeRuntimeResolverInput,
  portable: ResolvedPortableOpenCodeRuntime,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntimeStart,
): Omit<CodingRuntimeLaunchRequest, "runId" | "workspaceRoot" | "requestedMode"> {
  return {
    recoveryHandle: randomBytes(16).toString("hex"),
    treeBindingId: minted.treeBindingId,
    taskRef: context.taskId,
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    effectiveMode: minted.effectiveMode,
    executablePath: join(portable.installRoot, portable.sidecar.executablePath),
    managedRoot: join(portable.installRoot, portable.sidecar.payloadRootPath),
    gatewayUrl: `http://127.0.0.1:${input.env.KEIKO_UI_PORT ?? ""}/api/coding-sidecar/gateway`,
    modelProfileId: context.modelProfile.profileId,
    args: [],
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 5_000,
    startTimeoutMs: 30_000,
    confinement: portable.qualification,
  };
}

function idempotentEventSink(
  runId: string,
  authorityDigest: string,
  evidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
): Parameters<typeof createOpenCodeRuntimeComposition>[0]["governedEventSink"] {
  const identities = new Set<string>();
  return {
    execute: (identity, event): Promise<"duplicate" | "applied"> => {
      const duplicate = identities.has(identity);
      identities.add(identity);
      if (!duplicate) {
        evidence.observe(runId, {
          kind: event.kind === "tool" ? "tool-call" : "model-request",
          state: "running",
          authorityDigest,
        });
      }
      return Promise.resolve(duplicate ? "duplicate" : "applied");
    },
  };
}

function validGatewayPort(value: string | undefined): boolean {
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535;
}
