import { isAbsolute } from "node:path";

import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeIntent,
} from "@oscharko-dev/keiko-contracts";

import {
  EditorAgentAuthorityRegistry,
  editorAgentAuthorityRegistry,
} from "../editor/agentAuthorityRegistry.js";
import { editorAgentRegistry } from "../editor/agentSessionRegistry.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import { createCodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import {
  codingRuntimeStartConfirmationClaim,
  isConsumedRuntimeStartConfirmation,
  type CodingRuntimeStartConfirmationConsumer,
} from "./codingRuntimeStartConfirmation.js";
import type {
  CodingRuntimeLaunchRequest,
  CodingRuntimeManager,
  CodingRuntimeManagerDeps,
} from "./codingRuntimeManager.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import {
  createResearchGrantRegistry,
  type ResearchGrantRegistry,
} from "./researchGrantRegistry.js";
import {
  type ProductionCodingRuntimeResolver,
  type QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";
import { createProductionRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";
import {
  createProductionRuntimeOperationGuard,
  createProductionRuntimeManager,
  createProductionRuntimeTaskDispatcher,
  type ProductionRuntimeRunRecord,
  type ProductionRuntimeTurnPort,
} from "./productionCodingRuntimePorts.js";
import {
  createProductionManagedWorktreeToolFacade,
  type ProductionManagedWorktreeToolInput,
} from "./productionManagedWorktreeTools.js";
import {
  productionRuntimeAuthorityFacts,
  resolveProductionRuntimeContext,
  trustedManagedWorkspaceRoot,
  type ProductionWorkspaceAuthorityInput,
} from "./productionRuntimeWorkspaceAuthority.js";
import {
  CodingRuntimeAuthorityService,
  type CodingRuntimeMintResult,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";

type MintedRuntime = Extract<CodingRuntimeMintResult, { readonly ok: true }>;
type LaunchMaterial = Omit<
  CodingRuntimeLaunchRequest,
  "effectiveMode" | "requestedMode" | "runId" | "taskRef" | "treeBindingId" | "workspaceRoot"
>;

export interface ProductionRuntimeBackendInput {
  readonly request: Parameters<QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]>[0];
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntime;
  readonly toolFacade: CodingToolFacade;
  readonly authorityLifecycle: Pick<
    CodingRuntimeManagerDeps,
    | "abortInFlightActions"
    | "markRuntimeRecoveryRequired"
    | "releaseRuntimeAfterReap"
    | "revokeRuntime"
  >;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
}

export interface QualifiedProductionRuntimeRun {
  readonly manager: CodingRuntimeManager;
  readonly launch: LaunchMaterial;
  readonly turnPort: ProductionRuntimeTurnPort;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

export interface ProductionRuntimeBackendResolver {
  readonly createRun: (input: ProductionRuntimeBackendInput) => QualifiedProductionRuntimeRun;
}

export interface ProductionCodingRuntimeResolverInput {
  readonly workspaceAuthority: ProductionWorkspaceAuthorityInput;
  readonly backend: ProductionRuntimeBackendResolver;
  readonly secureWorkspaceTextRead: ProductionManagedWorktreeToolInput["secureWorkspaceTextRead"];
  readonly editorAgentClient: ProductionManagedWorktreeToolInput["editorAgentClient"];
  readonly verificationRunner: ProductionManagedWorktreeToolInput["verificationRunner"];
  readonly confirmationConsumer?: CodingRuntimeStartConfirmationConsumer | undefined;
  readonly authorityRegistry?: EditorAgentAuthorityRegistry | undefined;
}

interface ResolverRunRecord extends ProductionRuntimeRunRecord {
  readonly launch: LaunchMaterial;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
}

export function createProductionCodingRuntimeResolver(
  input: ProductionCodingRuntimeResolverInput,
): ProductionCodingRuntimeResolver {
  return {
    resolve: () =>
      input.confirmationConsumer !== undefined &&
      trustedManagedWorkspaceRoot(input.workspaceAuthority.managedTaskWorkspaceRoot)
        ? composeRuntime(input)
        : undefined,
  };
}

/** Builds the exact server-private claim #2377 must issue through the central confirmation plane. */
export function resolveProductionRuntimeStartConfirmationClaim(
  workspaceAuthority: ProductionWorkspaceAuthorityInput,
  request: ProductionRuntimeBackendInput["request"],
): ReturnType<typeof codingRuntimeStartConfirmationClaim> {
  const context = resolveProductionRuntimeContext(workspaceAuthority, request);
  const now = workspaceAuthority.now?.() ?? new Date();
  return codingRuntimeStartConfirmationClaim(confirmationFacts(request, context), now.getTime());
}

function composeRuntime(
  input: ProductionCodingRuntimeResolverInput,
): QualifiedProductionCodingRuntime {
  const authority = new CodingRuntimeAuthorityService(
    input.authorityRegistry ?? editorAgentAuthorityRegistry,
  );
  const runs = new Map<string, ResolverRunRecord>();
  // Server-level, run-bound registry of read-only research grants (#2387). Shared across the tool
  // facade (which the egress port reads), the revoke route, and revoke-before-terminate, so a grant
  // never outlives its run and revocation reaches the parent and every child at once.
  const researchGrants = createResearchGrantRegistry();
  let receiver: (event: CodingWorkbenchRuntimeEvent) => void = () => undefined;
  const manager = createProductionRuntimeManager(runs, authority, () => runtimeNow(input));
  return {
    createManager: (onRuntimeEvent): CodingRuntimeManager => {
      receiver = onRuntimeEvent;
      return manager;
    },
    mintLaunch: launchResolver(input, authority, runs, researchGrants, (event): void => {
      receiver(event);
    }),
    approvalAuthority: { issue: (request) => manager.issueApproval(request) },
    taskDispatcher: createProductionRuntimeTaskDispatcher(runs),
    questionPort: createProductionRuntimeQuestionPort(runs),
    cancellationRegistry: { signalFor: (runId) => runs.get(runId)?.controller.signal },
    runtimeCapabilityAuthenticator: {
      authenticate: (capability, audience) =>
        authority.authenticateCapability(capability, audience),
    },
  };
}

function launchResolver(
  input: ProductionCodingRuntimeResolverInput,
  authority: CodingRuntimeAuthorityService,
  runs: Map<string, ResolverRunRecord>,
  researchGrants: ResearchGrantRegistry,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): QualifiedProductionCodingRuntime["mintLaunch"] {
  return {
    resolve: (request): ReturnType<QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]> => {
      const context = resolveProductionRuntimeContext(input.workspaceAuthority, request);
      const intent = startIntent(request, context);
      const nowIso = runtimeNow(input).toISOString();
      const confirmation = input.confirmationConsumer?.consume(
        codingRuntimeStartConfirmationClaim(
          confirmationFacts(request, context),
          Date.parse(nowIso),
        ),
      );
      if (!isConsumedRuntimeStartConfirmation(confirmation)) {
        throw new Error("runtime-start-unconfirmed");
      }
      const minted = authority.mintConfirmedStartForRun(
        request.runId,
        intent,
        context,
        confirmation.approvalDigest,
        nowIso,
      );
      if (!minted.ok) throw new Error(minted.reason);
      try {
        const record = createRunRecord(
          input,
          request,
          context,
          minted,
          authority,
          researchGrants,
          onRuntimeEvent,
        );
        runs.set(request.runId, record);
        return launchRequest(record, context, minted);
      } catch (error) {
        authority.abandonUnlaunched(request.runId, runtimeNow(input).toISOString());
        throw error;
      }
    },
  };
}

function confirmationFacts(
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
): Parameters<typeof codingRuntimeStartConfirmationClaim>[0] {
  return {
    requestId: request.requestId,
    taskIntent: request.taskIntent,
    requestedMode: request.requestedMode,
    ...(request.runtimePreference ? { runtimePreference: request.runtimePreference } : {}),
    operatorId: context.operatorId,
    taskId: context.taskId,
    projectId: context.projectId,
    projectDigest: context.projectDigest,
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot,
    branchRef: context.branchRef,
    branchHeadDigest: context.branchHeadDigest,
    deploymentCeiling: context.deploymentCeiling,
    runtimeSource: context.runtimeSource,
    modelSource: context.modelProfile.source,
    modelProfileId: context.modelProfile.profileId,
  };
}

function createRunRecord(
  input: ProductionCodingRuntimeResolverInput,
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
  researchGrants: ResearchGrantRegistry,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): ResolverRunRecord {
  const controller = new AbortController();
  const invocationRegistry = createCodingToolInvocationRegistry();
  const leases = createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry,
    cancelPendingByAuthorityRun: (runId) => editorAgentRegistry.cancelPendingByAuthorityRun(runId),
  });
  const toolFacade = createManagedToolFacade(
    input,
    context,
    minted,
    authority,
    invocationRegistry,
    leases,
    researchGrants,
    onRuntimeEvent,
  );
  const backend = input.backend.createRun({
    request,
    context,
    minted,
    toolFacade,
    authorityLifecycle: authorityLifecycle(authority, controller, invocationRegistry, leases, () =>
      runtimeNow(input),
    ),
    onRuntimeEvent,
  });
  validateBackendLaunch(backend.launch, context);
  return assembleRunRecord({ input, request, context, minted, authority, backend }, controller, {
    invocationRegistry,
    leases,
  });
}

interface RunRecordDisposables {
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
}

interface RunRecordContext {
  readonly input: ProductionCodingRuntimeResolverInput;
  readonly request: ProductionRuntimeBackendInput["request"];
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntime;
  readonly authority: CodingRuntimeAuthorityService;
  readonly backend: ReturnType<ProductionRuntimeBackendResolver["createRun"]>;
}

function assembleRunRecord(
  parts: RunRecordContext,
  controller: AbortController,
  disposables: RunRecordDisposables,
): ResolverRunRecord {
  const { backend } = parts;
  return {
    manager: backend.manager,
    launch: backend.launch,
    turnPort: backend.turnPort,
    controller,
    operationGuard: createProductionRuntimeOperationGuard(parts.request.runId, () =>
      runtimeAuthorityLive(parts.input, parts.context, parts.minted, parts.authority),
    ),
    ...(backend.questionPort ? { questionPort: backend.questionPort } : {}),
    dispose: async (): Promise<void> => {
      disposables.leases.dispose();
      disposables.invocationRegistry.dispose();
      await backend.dispose?.();
    },
  };
}

function createManagedToolFacade(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
  invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>,
  leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>,
  researchGrants: ResearchGrantRegistry,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): CodingToolFacade {
  return createProductionManagedWorktreeToolFacade({
    authority,
    authorityRef: minted.authorityRef,
    adapterKind: adapterKind(context),
    workspaceRoot: context.workspaceRoot,
    researchGrantRegistry: researchGrants,
    // No proxy/CA is threaded from the model gateway here; research egress connects directly and
    // its dedicated config always denies loopback regardless. A proxied deployment would supply a
    // real accessor. Absent domains in the registry keep the egress port fail-closed.
    gatewayEgress: (): undefined => undefined,
    authorityExpiresAt: context.expiresAt,
    deploymentCeiling: context.deploymentCeiling,
    liveFacts: () => productionRuntimeAuthorityFacts(input.workspaceAuthority, context),
    secureWorkspaceTextRead: input.secureWorkspaceTextRead,
    editorAgentClient: input.editorAgentClient,
    mutationLeaseCoordinator: leases,
    invocationRegistry,
    verificationRunner: input.verificationRunner,
    onRuntimeEvent,
  });
}

function runtimeAuthorityLive(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
): boolean {
  const resolved = authority.revalidateCapabilityForMutation({
    capability: minted.toolFacadeCapability,
    adapterKind: adapterKind(context),
    liveFacts: productionRuntimeAuthorityFacts(input.workspaceAuthority, context),
    workspaceRoot: context.workspaceRoot,
    deploymentCeiling: context.deploymentCeiling,
    nowIso: runtimeNow(input).toISOString(),
  });
  return resolved.ok;
}

function adapterKind(
  context: CodingRuntimeTrustedContext,
): "model-gateway-sidecar" | "codex-cli-adapter" {
  return context.runtimeSource === "keiko-sidecar" ? "model-gateway-sidecar" : "codex-cli-adapter";
}

function authorityLifecycle(
  authority: CodingRuntimeAuthorityService,
  controller: AbortController,
  invocations: ReturnType<typeof createCodingToolInvocationRegistry>,
  leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>,
  now: () => Date,
): ProductionRuntimeBackendInput["authorityLifecycle"] {
  return {
    revokeRuntime: (runId): boolean => {
      controller.abort();
      invocations.revokeRun(runId);
      leases.revokeRun(runId);
      return authority.revokeBeforeTerminate(runId);
    },
    abortInFlightActions: (runId) => invocations.revokeRun(runId) >= 0,
    markRuntimeRecoveryRequired: (runId) =>
      authority.markRecoveryRequired(runId, now().toISOString()),
    releaseRuntimeAfterReap: (runId, receipt) =>
      authority.confirmReaped(runId, receipt, now().toISOString()),
  };
}

function runtimeNow(input: ProductionCodingRuntimeResolverInput): Date {
  return input.workspaceAuthority.now?.() ?? new Date();
}

function startIntent(
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
): Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }> {
  return {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    requestId: request.requestId,
    command: "start",
    taskIntent: request.taskIntent,
    requestedMode: request.requestedMode,
    modelSource: context.modelProfile.source,
  };
}

function validateBackendLaunch(launch: LaunchMaterial, context: CodingRuntimeTrustedContext): void {
  if (
    !isAbsolute(launch.executablePath) ||
    !isAbsolute(launch.managedRoot) ||
    launch.runtimeSource !== context.runtimeSource ||
    launch.modelSource !== context.modelProfile.source
  ) {
    throw new Error("runtime-backend-binding-invalid");
  }
}

function launchRequest(
  record: ResolverRunRecord,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
): ReturnType<QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]> {
  return {
    ...record.launch,
    effectiveMode: minted.effectiveMode,
    taskRef: context.taskId,
    treeBindingId: minted.treeBindingId,
  };
}
