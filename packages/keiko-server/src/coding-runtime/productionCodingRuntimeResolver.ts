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
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { CodingRuntimePermissionPort } from "./codingRuntimePermissionPort.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingSafeActivityProjection } from "./codingSafeActivityProjection.js";
import {
  createCodingRuntimeEditorMutationLeaseCoordinator,
  type CodingRuntimeEditorMutationLeaseBroker,
} from "./codingRuntimeEditorMutationLeaseCoordinator.js";
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
  createExplicitSkillInvocationTracker,
  type ExplicitSkillInvocationTracker,
} from "./explicitSkillInvocation.js";
import {
  buildResearchPermissionEvent,
  createPendingResearchApprovals,
  registerApprovedResearchGrant,
  type PendingResearchApprovals,
} from "./researchApprovalIssuance.js";
import {
  createResearchGrantRegistry,
  RESEARCH_GRANT_DEFAULT_MAX_TTL_MS,
  type ResearchGrantRegistry,
} from "./researchGrantRegistry.js";
import {
  type ProductionCodingRuntimeResolver,
  type CodingRuntimeTaskOutcome,
  type QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";
import { createProductionRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";
import { createProductionRuntimePermissionPort } from "./productionCodingRuntimePermissionPort.js";
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
import {
  createCodingToolApprovalBridge,
  type CodingToolApprovalBridge,
} from "./codingToolApprovalBridge.js";
import { createServerApprovedSkillCatalog, type SkillCatalog } from "./skillCatalog.js";

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
  readonly codingToolApprovals: CodingToolApprovalBridge;
  readonly authorityLifecycle: Pick<
    CodingRuntimeManagerDeps,
    | "abortInFlightActions"
    | "markRuntimeRecoveryRequired"
    | "releaseRuntimeAfterReap"
    | "revokeRuntime"
  >;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly workspaceIsCurrent: () => boolean;
}

export interface QualifiedProductionRuntimeRun {
  readonly manager: CodingRuntimeManager;
  readonly launch: LaunchMaterial;
  readonly turnPort: ProductionRuntimeTurnPort;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

export interface ProductionRuntimeBackendResolver {
  readonly createRun: (input: ProductionRuntimeBackendInput) => QualifiedProductionRuntimeRun;
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
}

export interface ProductionCodingRuntimeResolverInput {
  readonly workspaceAuthority: ProductionWorkspaceAuthorityInput;
  readonly backend: ProductionRuntimeBackendResolver;
  readonly secureWorkspaceTextRead: ProductionManagedWorktreeToolInput["secureWorkspaceTextRead"];
  readonly editorAgentClient: ProductionManagedWorktreeToolInput["editorAgentClient"];
  readonly verificationRunner: ProductionManagedWorktreeToolInput["verificationRunner"];
  readonly confirmationConsumer?: CodingRuntimeStartConfirmationConsumer | undefined;
  readonly authorityRegistry?: EditorAgentAuthorityRegistry | undefined;
  readonly runtimeMutationLeaseBroker?:
    Pick<CodingRuntimeEditorMutationLeaseBroker, "attach"> | undefined;
  readonly gatewayEgress?: ProductionManagedWorktreeToolInput["gatewayEgress"] | undefined;
  readonly childModelPortFactory?:
    ProductionManagedWorktreeToolInput["childModelPortFactory"] | undefined;
  /**
   * The PROVIDER model id a read-only child agent runs on (#2387). Resolved per run because the
   * coding-safe gateway profile can change while the server is up. This is deliberately NOT the
   * run's `modelProfile.profileId`: that is a Keiko launch-profile identifier
   * (`coding-safe-openai-compatible`), which the model gateway cannot resolve — handing it to a
   * child session would fail every child's first model call. When no coding-safe model is
   * configured the child port stays fail-closed rather than guessing an id.
   */
  readonly childModelId?: (() => string | undefined) | undefined;
  /** Explicit hermetic-test seam for the research transport. Production never supplies this. */
  readonly researchFetchImpl?: ProductionManagedWorktreeToolInput["researchFetchImpl"] | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

interface ResolverRunRecord extends ProductionRuntimeRunRecord {
  readonly launch: LaunchMaterial;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
}

/** The two server-level #2387 research stores threaded together through the run composition. */
interface ResearchComposition {
  readonly grants: ResearchGrantRegistry;
  readonly pending: PendingResearchApprovals;
}

/** Wraps the manager's approval issuance with the #2387 research grant minting hook. */
function researchIssuingApprovalAuthority(
  manager: CodingRuntimeManager,
  research: ResearchComposition,
  now: () => Date,
): QualifiedProductionCodingRuntime["approvalAuthority"] {
  return {
    issue: (request): ReturnType<CodingRuntimeManager["issueApproval"]> => {
      const issued = manager.issueApproval(request);
      if (issued.ok && request.actionKind === "research") {
        const grantExpiresAtMs = now().getTime() + RESEARCH_GRANT_DEFAULT_MAX_TTL_MS;
        registerApprovedResearchGrant(
          { pending: research.pending, registry: research.grants, now },
          request,
          issued.approvalDigest,
          grantExpiresAtMs,
        );
      }
      return issued;
    },
  };
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
  // Transient URL retention between "the model asked for this URL" and "the operator approved it".
  // In memory only; invalidated with the run.
  const pendingResearch = createPendingResearchApprovals();
  let receiver: (event: CodingWorkbenchRuntimeEvent) => void = () => undefined;
  const manager = createProductionRuntimeManager(runs, authority, () => runtimeNow(input));
  const research: ResearchComposition = { grants: researchGrants, pending: pendingResearch };
  return {
    createManager: (onRuntimeEvent): CodingRuntimeManager => {
      receiver = onRuntimeEvent;
      return manager;
    },
    mintLaunch: launchResolver(input, authority, runs, research, (event): void => {
      receiver(event);
    }),
    // The approved `research` action mints its grant here — the one seam that sees both the
    // manager's approval issuance (approval digest + expiry) and the retained approved URL.
    approvalAuthority: researchIssuingApprovalAuthority(manager, research, () => runtimeNow(input)),
    researchGrants,
    pendingResearchApprovals: pendingResearch,
    taskDispatcher: createProductionRuntimeTaskDispatcher(runs, input.diagnostics),
    questionPort: createProductionRuntimeQuestionPort(runs),
    permissionPort: createProductionRuntimePermissionPort(runs),
    cancellationRegistry: { signalFor: (runId) => runs.get(runId)?.controller.signal },
    runtimeCapabilityAuthenticator: {
      authenticate: (capability, audience) =>
        authority.authenticateCapability(capability, audience),
      reservePromptTokens: (capability, promptTokens) =>
        authority.reservePromptTokens(capability, promptTokens),
    },
    ...(input.backend.safeActivityProjection
      ? { safeActivityProjection: input.backend.safeActivityProjection }
      : {}),
  };
}

function launchResolver(
  input: ProductionCodingRuntimeResolverInput,
  authority: CodingRuntimeAuthorityService,
  runs: Map<string, ResolverRunRecord>,
  research: ResearchComposition,
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
          research,
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
    ...(request.modelId ? { modelId: request.modelId } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
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

// The per-run governed tool surface: the invocation registry every tool call is recorded against,
// its mutation-lease coordinator, the explicit-skill tracker seeded from this turn's intent, and the
// managed facade the runtime actually calls. Built as one unit because the facade closes over the
// other three.
interface RunToolSurface {
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createLeaseCoordinator>;
  readonly explicitSkills: ReturnType<typeof createExplicitSkillInvocationTracker>;
  readonly toolFacade: ReturnType<typeof createManagedToolFacade>;
  readonly codingToolApprovals: CodingToolApprovalBridge;
}

function createRunToolSurface(
  input: ProductionCodingRuntimeResolverInput,
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
  research: ResearchComposition,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): RunToolSurface {
  const invocationRegistry = createCodingToolInvocationRegistry();
  const codingToolApprovals = createCodingToolApprovalBridge();
  const leases = createLeaseCoordinator(invocationRegistry);
  const skillCatalog = createServerApprovedSkillCatalog();
  const explicitSkills = createExplicitSkillInvocationTracker(skillCatalog);
  explicitSkills.observeTurn(request.taskIntent);
  const toolFacade = createManagedToolFacade({
    input,
    context,
    minted,
    authority,
    invocationRegistry,
    leases,
    research,
    skillCatalog,
    explicitSkills,
    codingToolApprovals,
    onRuntimeEvent,
  });
  return { invocationRegistry, leases, explicitSkills, toolFacade, codingToolApprovals };
}

function createRunRecord(
  input: ProductionCodingRuntimeResolverInput,
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
  research: ResearchComposition,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): ResolverRunRecord {
  const controller = new AbortController();
  const { invocationRegistry, leases, explicitSkills, toolFacade, codingToolApprovals } =
    createRunToolSurface(input, request, context, minted, authority, research, onRuntimeEvent);
  const backend = createBackendRun({
    input,
    request,
    context,
    minted,
    toolFacade,
    codingToolApprovals,
    authority,
    controller,
    invocationRegistry,
    leases,
    research,
    onRuntimeEvent,
  });
  validateBackendLaunch(backend.launch, context);
  const detachLease = attachRuntimeMutationLease(input, leases, invocationRegistry);
  return {
    manager: backend.manager,
    launch: backend.launch,
    turnPort: bindExplicitSkillTurns(backend.turnPort, explicitSkills),
    controller,
    operationGuard: createProductionRuntimeOperationGuard(request.runId, () =>
      runtimeAuthorityLive(input, context, minted, authority),
    ),
    waitForPendingMutations: (signal) => leases.waitForIdle(signal),
    ...(backend.questionPort ? { questionPort: backend.questionPort } : {}),
    ...(backend.permissionPort ? { permissionPort: backend.permissionPort } : {}),
    dispose: createRunDisposer(detachLease, leases, invocationRegistry, backend),
  };
}

function bindExplicitSkillTurns(
  turnPort: ProductionRuntimeTurnPort,
  explicitSkills: ExplicitSkillInvocationTracker,
): ProductionRuntimeTurnPort {
  return {
    submitTurn: async (runId, text): Promise<boolean> => {
      explicitSkills.observeTurn(text);
      const accepted = await turnPort.submitTurn(runId, text);
      if (!accepted) explicitSkills.clear();
      return accepted;
    },
    abortTurn: async (runId): Promise<boolean> => {
      explicitSkills.clear();
      return turnPort.abortTurn(runId);
    },
    waitForTerminal: async (runId, signal): Promise<CodingRuntimeTaskOutcome> => {
      try {
        return await turnPort.waitForTerminal(runId, signal);
      } finally {
        explicitSkills.clear();
      }
    },
  };
}

function createRunDisposer(
  detachLease: (() => void) | undefined,
  leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>,
  invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>,
  backend: QualifiedProductionRuntimeRun,
): () => Promise<void> {
  return async (): Promise<void> => {
    detachLease?.();
    leases.dispose();
    invocationRegistry.dispose();
    await backend.dispose?.();
  };
}

function attachRuntimeMutationLease(
  input: ProductionCodingRuntimeResolverInput,
  leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>,
  invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>,
): (() => void) | undefined {
  const broker = input.runtimeMutationLeaseBroker;
  if (broker === undefined) return undefined;
  const detach = broker.attach(leases.lease);
  if (detach !== undefined) return detach;
  leases.dispose();
  invocationRegistry.dispose();
  throw new Error("runtime-mutation-lease-broker-unavailable");
}

function createLeaseCoordinator(
  invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>,
): ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator> {
  return createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry,
    cancelPendingByAuthorityRun: (runId) => editorAgentRegistry.cancelPendingByAuthorityRun(runId),
  });
}

/** One parameter object: the backend run needs the whole run context, not an argument list to mis-order. */
interface CreateBackendRunInput {
  readonly input: ProductionCodingRuntimeResolverInput;
  readonly request: ProductionRuntimeBackendInput["request"];
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntime;
  readonly toolFacade: CodingToolFacade;
  readonly codingToolApprovals: CodingToolApprovalBridge;
  readonly authority: CodingRuntimeAuthorityService;
  readonly controller: AbortController;
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  readonly research: ResearchComposition;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
}

function createBackendRun({
  input,
  request,
  context,
  minted,
  toolFacade,
  codingToolApprovals,
  authority,
  controller,
  invocationRegistry,
  leases,
  research,
  onRuntimeEvent,
}: CreateBackendRunInput): QualifiedProductionRuntimeRun {
  return input.backend.createRun({
    request,
    context,
    minted,
    toolFacade,
    codingToolApprovals,
    authorityLifecycle: authorityLifecycle(
      authority,
      controller,
      invocationRegistry,
      leases,
      research,
      () => runtimeNow(input),
    ),
    onRuntimeEvent,
    workspaceIsCurrent: () =>
      input.workspaceAuthority.workspaceLifecycle.getActive()?.instance.workspaceId ===
      context.workspaceId,
  });
}

/** One parameter object: the facade needs the whole run context, not an argument list to mis-order. */
interface ManagedToolFacadeInput {
  readonly input: ProductionCodingRuntimeResolverInput;
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntime;
  readonly authority: CodingRuntimeAuthorityService;
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  readonly research: ResearchComposition;
  readonly skillCatalog: SkillCatalog;
  readonly explicitSkills: ExplicitSkillInvocationTracker;
  readonly codingToolApprovals: CodingToolApprovalBridge;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
}

function createManagedToolFacade({
  input,
  context,
  minted,
  authority,
  invocationRegistry,
  leases,
  research,
  skillCatalog,
  explicitSkills,
  codingToolApprovals,
  onRuntimeEvent,
}: ManagedToolFacadeInput): CodingToolFacade {
  const childModelId = input.childModelId?.();
  return createProductionManagedWorktreeToolFacade({
    authority,
    authorityRef: minted.authorityRef,
    taskId: context.taskId,
    // The child agent talks to the gateway directly, so it needs the resolved PROVIDER model id —
    // never the run's launch-profile identifier, which the gateway cannot resolve.
    ...(childModelId === undefined ? {} : { modelId: childModelId }),
    adapterKind: adapterKind(context),
    workspaceRoot: context.workspaceRoot,
    ...managedResearchOptions(input, context, minted, research, onRuntimeEvent),
    authorityExpiresAt: context.expiresAt,
    effectiveMode: minted.effectiveMode,
    effectiveModeNow: () => authority.effectiveMode(),
    reservePromptTokens: (promptTokens): boolean =>
      authority.reservePromptTokens(minted.modelGatewayCapability, promptTokens).ok,
    deploymentCeiling: context.deploymentCeiling,
    liveFacts: () => productionRuntimeAuthorityFacts(input.workspaceAuthority, context),
    secureWorkspaceTextRead: input.secureWorkspaceTextRead,
    editorAgentClient: input.editorAgentClient,
    mutationLeaseCoordinator: leases,
    invocationRegistry,
    approvalProofVerifier: codingToolApprovals,
    skillCatalog,
    explicitSkillInvocations: explicitSkills,
    childModelPortFactory: input.childModelPortFactory,
    verificationRunner: input.verificationRunner,
    onRuntimeEvent,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

function managedResearchOptions(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  research: ResearchComposition,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): Pick<
  ProductionManagedWorktreeToolInput,
  "gatewayEgress" | "requestResearchApproval" | "researchFetchImpl" | "researchGrantRegistry"
> {
  return {
    researchGrantRegistry: research.grants,
    gatewayEgress: input.gatewayEgress ?? ((): undefined => undefined),
    requestResearchApproval: researchApprovalRequester(
      input,
      context,
      minted.authorityRef.runId,
      research.pending,
      onRuntimeEvent,
    ),
    ...(input.researchFetchImpl ? { researchFetchImpl: input.researchFetchImpl } : {}),
  };
}

// Opens the #2387 approval loop for a research URL no grant covers: retain the URL transiently and
// raise the content-free `network-egress` permission request. One ask per run at a time; a refused
// or invalid ask emits nothing and the fetch stays failed closed.
function researchApprovalRequester(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  runId: string,
  pending: PendingResearchApprovals,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): (url: URL) => void {
  let sequence = 0;
  return (url: URL): void => {
    const nowMs = runtimeNow(input).getTime();
    const requestId = pending.request({
      runId,
      url,
      taskId: context.taskId,
      workspaceId: context.workspaceId,
      nowMs,
    });
    if (requestId === undefined) return;
    sequence += 1;
    const event = buildResearchPermissionEvent({ runId, requestId, sequence, nowMs });
    if (event !== undefined) onRuntimeEvent(event);
  };
}

function runtimeAuthorityLive(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
): boolean {
  // Operator admission, not a child tool mutation: the guarded operations (follow-up dispatch,
  // abort, question answers) are deliberately reachable while the run is paused — sticky pause
  // holds the runtime, not the human. The tool facade keeps the running-only revalidation.
  const resolved = authority.revalidateCapabilityForOperatorAdmission({
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
  research: ResearchComposition,
  now: () => Date,
): ProductionRuntimeBackendInput["authorityLifecycle"] {
  return {
    revokeRuntime: (runId): boolean => {
      controller.abort();
      invocations.revokeRun(runId);
      leases.revokeRun(runId);
      // Drop every read-only research grant AND any unanswered research ask for the run so a
      // terminate/revoke leaves no orphaned internet reach for the parent or any child (#2387).
      research.grants.invalidateRun(runId);
      research.pending.invalidateRun(runId);
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
