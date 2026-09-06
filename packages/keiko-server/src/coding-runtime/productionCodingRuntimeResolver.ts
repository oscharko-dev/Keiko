import {
  createProductionDraftDeliveryService,
  requestDraftDeliveryApproval,
} from "./productionDraftDeliveryRuntime.js";
import type {
  DraftDeliveryDependencies,
  DraftDeliveryService,
} from "../gitDelivery/draftDeliveryTypes.js";
import type { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import type { GitDeliveryDescriptionAuthorityMintRequest } from "../gitDelivery/runBoundAuthority.js";
import { createProductionCiObservationService } from "./productionCiObservationRuntime.js";
import { createProductionCiRepairBudget } from "./productionCiRepairRuntime.js";
import { reservePromptWithCiRepair } from "./ciRepairPromptReservation.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import {
  createProductionRuntimeGitService,
  requestRuntimeStageApproval,
} from "./productionVerifiedCommitRuntime.js";
import {
  createProductionVerifiedCommitService,
  requestVerifiedCommitApproval,
  type VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import type { VerifiedCommitService } from "../gitDelivery/verifiedCommitTypes.js";
import { createRuntimeGitPreparation } from "./productionRuntimeGitPreparation.js";
import { isAbsolute } from "node:path";

import type {
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimeIntent,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { isCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

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
import type { OpenCodeToolBridge } from "./opencodeRuntimeComposition.js";
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
  deriveOptionalToolAvailability,
  type ProductionManagedWorktreeToolInput,
} from "./productionManagedWorktreeTools.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";
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
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import { isIdentityProofFailure } from "../task-workspace/errors.js";

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
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
}

export interface QualifiedProductionRuntimeRun {
  readonly manager: CodingRuntimeManager;
  readonly launch: LaunchMaterial;
  readonly turnPort: ProductionRuntimeTurnPort;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
  /**
   * ADR-0043 D11-D14 (#3390): the governed tool bridge for this run, dispatched directly by the
   * BFF's `/api/coding-sidecar/tool` route -- optional so a backend that never composes an
   * OpenCode-style bridge (e.g. a test double) is not forced to fabricate one.
   */
  readonly toolBridge?: OpenCodeToolBridge | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

export interface ProductionRuntimeBackendResolver {
  readonly createRun: (input: ProductionRuntimeBackendInput) => QualifiedProductionRuntimeRun;
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
}

export interface ProductionCodingRuntimeResolverInput {
  readonly verifiedCommit?: VerifiedCommitRuntimeDependencies;
  readonly draftDelivery?: DraftDeliveryDependencies;
  readonly workspaceAuthority: ProductionWorkspaceAuthorityInput;
  readonly backend: ProductionRuntimeBackendResolver;
  readonly secureWorkspaceTextRead: ProductionManagedWorktreeToolInput["secureWorkspaceTextRead"];
  readonly editorAgentClient: ProductionManagedWorktreeToolInput["editorAgentClient"];
  readonly verificationRunner: ProductionManagedWorktreeToolInput["verificationRunner"];
  readonly commandRunner?: ProductionManagedWorktreeToolInput["commandRunner"] | undefined;
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
  readonly resolveWorkspaceRootAccess: (requestedRoot: string) => WorkspaceRootAccess | undefined;
}

interface ResolverRunRecord extends ProductionRuntimeRunRecord {
  readonly ciRepairBudget?: CiRepairExecutionBudget | undefined;
  readonly launch: LaunchMaterial;
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
  readonly toolBridge?: OpenCodeToolBridge | undefined;
  readonly unavailableOptionalTools: () => ReadonlySet<OpenCodeOptionalToolName>;
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
  // Arity matches the declared slot deliberately (not just `() => undefined`): the placeholder
  // is itself a value of type `(event: CodingWorkbenchRuntimeEvent) => void`, so every call site
  // below passes exactly the one argument that type accepts -- confirmed a real callee-arity
  // mismatch is not being papered over here.
  let receiver: (event: CodingWorkbenchRuntimeEvent) => void = (_event) => undefined;
  // #3401 (epic #3384 closeout, description-composition-closeout): the orchestrator that owns
  // `notifyVerifiedHeadAdvanced` is built by `codingRuntimeControlPlane.ts` AFTER this resolver
  // (and every per-run CI-repair budget it mints) already exists, so a per-run controller cannot
  // receive it at construction time. Mirrors the `receiver` indirection immediately above: a
  // mutable slot a run-bound closure reads through, filled in once by
  // `attachVerifiedHeadNotifier` right after the control plane builds its orchestrator.
  const verifiedHeadNotifier: { current: (runId: string) => void } = { current: () => undefined };
  // ADR-0043 D11-D14 (#3390): at most one run's tool bridge is ever active (the singleton-run
  // governance gate in codingRuntimeOrchestrator.ts), so "the current bridge" is one mutable slot
  // -- the SAME idiom as `receiver`/`verifiedHeadNotifier` above -- set when a run's backend
  // composes its bridge and cleared on that run's own disposal (guarded by identity so a
  // late-settling dispose can never clear a NEWER run's bridge).
  const toolFacadeBridge: { current: OpenCodeToolBridge | undefined } = { current: undefined };
  const manager = createProductionRuntimeManager(runs, authority, () => runtimeNow(input));
  const research: ResearchComposition = { grants: researchGrants, pending: pendingResearch };
  return {
    createManager: (onRuntimeEvent): CodingRuntimeManager => {
      receiver = onRuntimeEvent;
      return manager;
    },
    mintLaunch: composedMintLaunch(
      input,
      authority,
      runs,
      research,
      (event): void => {
        receiver(event);
      },
      verifiedHeadNotifier,
      toolFacadeBridge,
    ),
    toolFacadeBridge: { resolve: (): OpenCodeToolBridge | undefined => toolFacadeBridge.current },
    // The approved `research` action mints its grant here — the one seam that sees both the
    // manager's approval issuance (approval digest + expiry) and the retained approved URL.
    approvalAuthority: researchIssuingApprovalAuthority(manager, research, () => runtimeNow(input)),
    researchGrants,
    pendingResearchApprovals: pendingResearch,
    taskDispatcher: createProductionRuntimeTaskDispatcher(runs, input.diagnostics),
    questionPort: createProductionRuntimeQuestionPort(runs),
    permissionPort: createProductionRuntimePermissionPort(runs),
    cancellationRegistry: { signalFor: (runId) => runs.get(runId)?.controller.signal },
    runtimeCapabilityAuthenticator: runtimeCapabilityAuthenticatorFor(authority, runs),
    gitDeliveryAuthority: authority.gitDeliveryAuthorityPort(),
    // #3399 (epic #3384 correction 4): threaded through the exact same chain as
    // `gitDeliveryAuthority` above (-> productionCodingRuntimeHost.ts ->
    // codingRuntimeControlPlane.ts -> deps.ts) so the server-minted description authority is
    // reachable from a live server for the Chat and post-terminal generation paths, not only from
    // a running Code task.
    gitDeliveryDescriptionAuthority: authority.gitDeliveryDescriptionAuthorityPort(),
    // #3401 (epic #3384 closeout, description-composition-closeout): the MINT capability the
    // comment above named as the still-missing half. `gitDeliveryDescriptionAuthority` only reads
    // an existing record; nothing minted one, so the automatic-description dispatcher
    // (`productionCodingRuntimePorts.ts`) admitted every scope closed in production. The caller's
    // action-specific accepted mode reaches the owner here and is clamped by the deployment
    // ceiling; an absent or invalid mode mints nothing.
    mintDescriptionAuthority: mintDescriptionAuthorityFor(authority, input),
    // #3401 CI-repair notify: the setter half of the `notifyVerifiedHeadAdvanced` slot above.
    // Called exactly once by `codingRuntimeControlPlane.ts` right after it builds the orchestrator
    // that owns the real method.
    attachVerifiedHeadNotifier: (notify: (runId: string) => void): void => {
      verifiedHeadNotifier.current = notify;
    },
    ...(input.backend.safeActivityProjection
      ? { safeActivityProjection: input.backend.safeActivityProjection }
      : {}),
  };
}

// Extracted so `composeRuntime` stays under AGENTS.md §6's 50-line ceiling: bundles the
// verified-head and tool-facade-bridge notification slots onto `launchResolver`'s call, which
// `composeRuntime` otherwise builds inline.
function composedMintLaunch(
  input: ProductionCodingRuntimeResolverInput,
  authority: CodingRuntimeAuthorityService,
  runs: Map<string, ResolverRunRecord>,
  research: ResearchComposition,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  verifiedHeadNotifier: { current: (runId: string) => void },
  toolFacadeBridge: { current: OpenCodeToolBridge | undefined },
): QualifiedProductionCodingRuntime["mintLaunch"] {
  return launchResolver(
    input,
    authority,
    runs,
    research,
    onRuntimeEvent,
    (runId): void => {
      verifiedHeadNotifier.current(runId);
    },
    toolFacadeBridge,
  );
}

// #3384 wave-3 W3-3 "needs": `settlePromptTokens` (agentAuthorityRegistry.ts) had zero production
// callers -- this is the wiring. `CodingRuntimeHost["runtimeCapabilityAuthenticator"]` (the
// interface the return type below is checked against) does not itself declare `settlePromptTokens`
// yet, so the return type is widened with an explicit intersection instead of touching that shared
// interface: the object literal below satisfies both the narrower contract every existing consumer
// still reads and the wider one `coding-sidecar-gateway.ts`'s settlement call site expects.
function runtimeCapabilityAuthenticatorFor(
  authority: CodingRuntimeAuthorityService,
  runs: Map<string, ResolverRunRecord>,
): NonNullable<QualifiedProductionCodingRuntime["runtimeCapabilityAuthenticator"]> & {
  readonly settlePromptTokens: (
    capability: string,
    reservedPromptTokens: number,
    actualPromptTokens: number,
  ) => unknown;
  // #3384 wave-3 W3-1 redirect: the real per-run fact `coding-sidecar-gateway.ts`'s outgoing
  // tool-catalog advertisement needs, keyed by runId the same way `ciRepairBudget` already is
  // above. `undefined` (run not tracked here) preserves the advertisement's prior,
  // structural-only behaviour rather than claiming every optional tool is unavailable.
  readonly unavailableOptionalTools: (
    runId: string,
  ) => ReadonlySet<OpenCodeOptionalToolName> | undefined;
} {
  return {
    authenticate: (capability, audience) => authority.authenticateCapability(capability, audience),
    reservePromptTokens: (capability, promptTokens) =>
      reservePromptWithCiRepair(
        authority,
        (runId) => runs.get(runId)?.ciRepairBudget,
        capability,
        promptTokens,
      ),
    settlePromptTokens: (capability, reservedPromptTokens, actualPromptTokens) =>
      authority.settlePromptTokens(capability, reservedPromptTokens, actualPromptTokens),
    unavailableOptionalTools: (runId) => runs.get(runId)?.unavailableOptionalTools(),
  };
}

// #3401 (epic #3384 closeout, description-composition-closeout): the MINT capability
// `gitDeliveryDescriptionAuthority`'s READ port needs a producer for. It receives the actual mode
// accepted for the calling action and clamps that mode to the deployment ceiling. An invalid or
// unavailable accepted mode mints nothing; the subsequent authority read therefore denies closed.
function mintDescriptionAuthorityFor(
  authority: CodingRuntimeAuthorityService,
  input: ProductionCodingRuntimeResolverInput,
): (request: GitDeliveryDescriptionAuthorityMintRequest) => void {
  return (request): void => {
    if (!isCodingWorkbenchMode(request.requestedMode)) return;
    authority.mintGitDeliveryDescriptionAuthority({
      scope: request.scope,
      requestedMode: request.requestedMode,
      deploymentCeiling: input.workspaceAuthority.deploymentCeiling,
      nowIso: request.nowIso,
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
    });
  };
}

function repositoryPreparationFor(
  input: ProductionCodingRuntimeResolverInput,
): ReturnType<typeof createRuntimeGitPreparation> | undefined {
  return input.verifiedCommit === undefined
    ? undefined
    : createRuntimeGitPreparation({
        deps: input.verifiedCommit,
        context: (request) => resolveProductionRuntimeContext(input.workspaceAuthority, request),
        now: () => runtimeNow(input).getTime(),
      });
}

function launchResolver(
  input: ProductionCodingRuntimeResolverInput,
  authority: CodingRuntimeAuthorityService,
  runs: Map<string, ResolverRunRecord>,
  research: ResearchComposition,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  notifyVerifiedHeadAdvanced: (runId: string) => void,
  toolFacadeBridge: { current: OpenCodeToolBridge | undefined },
): QualifiedProductionCodingRuntime["mintLaunch"] {
  const preparation = repositoryPreparationFor(input);
  return {
    ...(preparation === undefined ? {} : { prepare: preparation.prepare }),
    resolve: (request): ReturnType<QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]> => {
      const context =
        preparation === undefined
          ? resolveProductionRuntimeContext(input.workspaceAuthority, request)
          : preparation.consume(request);
      const intent = startIntent(request, context);
      const nowIso = runtimeNow(input).toISOString();
      const approvalDigest = consumeStartConfirmation(input, request, context, nowIso);
      const minted = authority.mintConfirmedStartForRun(
        request.runId,
        intent,
        context,
        approvalDigest,
        nowIso,
      );
      if (!minted.ok) throw new Error(minted.reason);
      try {
        const record = createRunRecord({
          input,
          request,
          context,
          minted,
          authority,
          research,
          onRuntimeEvent,
          notifyVerifiedHeadAdvanced,
        });
        runs.set(request.runId, withCurrentToolFacadeBridge(record, toolFacadeBridge));
        return launchRequest(record, context, minted);
      } catch (error) {
        authority.abandonUnlaunched(request.runId, runtimeNow(input).toISOString());
        throw error;
      }
    },
  };
}

function consumeStartConfirmation(
  input: ProductionCodingRuntimeResolverInput,
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
  nowIso: string,
): string {
  const confirmation = input.confirmationConsumer?.consume(
    codingRuntimeStartConfirmationClaim(confirmationFacts(request, context), Date.parse(nowIso)),
  );
  if (!isConsumedRuntimeStartConfirmation(confirmation))
    throw new Error("runtime-start-unconfirmed");
  return confirmation.approvalDigest;
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
    ...(context.repositoryIdentity === undefined
      ? {}
      : { repositoryIdentity: context.repositoryIdentity }),
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot,
    branchRef: context.branchRef,
    branchHeadDigest: context.branchHeadDigest,
    deploymentCeiling: context.deploymentCeiling,
    runtimeSource: context.runtimeSource,
    modelSource: context.modelProfile.source,
    modelProfileId: context.modelProfile.profileId,
    ...(context.issueBinding === undefined
      ? {}
      : { issueBindingDigest: context.issueBinding.bindingDigest }),
  };
}

// The per-run governed tool surface: the invocation registry every tool call is recorded against,
// its mutation-lease coordinator, the explicit-skill tracker seeded from this turn's intent, and the
// managed facade the runtime actually calls. Built as one unit because the facade closes over the
// other three.
interface RunToolSurface {
  readonly ciRepairBudget: CiRepairExecutionBudget | undefined;
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createLeaseCoordinator>;
  readonly explicitSkills: ReturnType<typeof createExplicitSkillInvocationTracker>;
  readonly toolFacade: ReturnType<typeof createManagedToolFacade>;
  readonly codingToolApprovals: CodingToolApprovalBridge;
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
  /**
   * #3384 wave-3 W3-1 redirect (reviewer 3941816393 / B1): the SAME real, non-fake per-run
   * availability fact `createManagedToolFacade` already computes for the child-facing tool ports
   * below (`deriveOptionalToolAvailability`), retained here so the gateway's OUTGOING tool-catalog
   * advertisement (coding-sidecar-gateway.ts) can derive its readiness from real bindings instead
   * of the catalog's static declarations alone (#3413-AC1/#3414-AC4/AC9).
   */
  readonly unavailableOptionalTools: () => ReadonlySet<OpenCodeOptionalToolName>;
}

function commitServiceFor(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
  signal: AbortSignal,
): VerifiedCommitService | undefined {
  return createProductionVerifiedCommitService(input.verifiedCommit, {
    runId: minted.authorityRef.runId,
    envelopeDigest: minted.authorityRef.envelopeDigest,
    context,
    signal,
    stillAuthorized: () => runtimeMutationLive(input, context, minted, authority),
  });
}

interface RuntimeGitServices {
  readonly ciRepairBudget: CiRepairExecutionBudget | undefined;
  readonly draftDeliveryService: DraftDeliveryService | undefined;
  readonly ciObservationService: CiObservationService | undefined;
  readonly verifiedCommitService: VerifiedCommitService | undefined;
  readonly runtimeGitService: RuntimeGitService | undefined;
  readonly codingToolApprovals: CodingToolApprovalBridge;
}
function runtimeGitServices(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
  signal: AbortSignal,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  notifyVerifiedHeadAdvanced: (runId: string) => void,
): RuntimeGitServices {
  const binding = {
    runId: minted.authorityRef.runId,
    envelopeDigest: minted.authorityRef.envelopeDigest,
    context,
    signal,
    stillAuthorized: (): boolean => runtimeMutationLive(input, context, minted, authority),
  };
  const verifiedCommitService = commitServiceFor(input, context, minted, authority, signal);
  const { ciRepairBudget, ciObservationService } = runtimeCiServices(
    input,
    binding,
    onRuntimeEvent,
    notifyVerifiedHeadAdvanced,
  );
  const runtimeGitService = createProductionRuntimeGitService(
    input.verifiedCommit,
    binding,
    () => authority.effectiveMode(),
    () => verifiedCommitService?.invalidate(),
  );
  const draftDeliveryService = createProductionDraftDeliveryService(
    input.draftDelivery,
    input.verifiedCommit,
    binding,
    onRuntimeEvent,
  );
  const codingToolApprovals = createCodingToolApprovalBridge(
    verifiedCommitService,
    runtimeGitService,
    draftDeliveryService,
  );
  return {
    verifiedCommitService,
    ciRepairBudget,
    runtimeGitService,
    draftDeliveryService,
    ciObservationService,
    codingToolApprovals,
  };
}

function runtimeCiServices(
  input: ProductionCodingRuntimeResolverInput,
  binding: Parameters<typeof createProductionCiRepairBudget>[2],
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  notifyVerifiedHeadAdvanced: (runId: string) => void,
): Pick<RuntimeGitServices, "ciRepairBudget" | "ciObservationService"> {
  const ciRepairBudget = createProductionCiRepairBudget(
    input.draftDelivery,
    input.verifiedCommit,
    binding,
    notifyVerifiedHeadAdvanced,
  );
  const ciObservationService = createProductionCiObservationService(
    input.draftDelivery,
    input.verifiedCommit,
    binding,
    onRuntimeEvent,
    ciRepairBudget,
  );
  return { ciRepairBudget, ciObservationService };
}

interface RunToolContextPieces {
  readonly leases: ReturnType<typeof createLeaseCoordinator>;
  readonly skillCatalog: SkillCatalog;
  readonly explicitSkills: ReturnType<typeof createExplicitSkillInvocationTracker>;
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
}

// Extracted so `createRunToolSurface` stays under AGENTS.md §6's 50-line ceiling: this piece is
// independent of the git/CI services `runtimeGitServices` builds, only of the invocation registry
// leases are coordinated against.
function prepareRunToolContext(
  input: ProductionCodingRuntimeResolverInput,
  request: ProductionRuntimeBackendInput["request"],
  context: CodingRuntimeTrustedContext,
  invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>,
): RunToolContextPieces {
  const leases = createLeaseCoordinator(invocationRegistry);
  const skillCatalog = createServerApprovedSkillCatalog();
  const explicitSkills = createExplicitSkillInvocationTracker(skillCatalog);
  const resolveWorkspaceRootAccess = runWorkspaceRootAccessResolver(input, context);
  if (resolveWorkspaceRootAccess() === undefined) throw new Error("runtime-workspace-unqualified");
  explicitSkills.observeTurn(request.taskIntent);
  return { leases, skillCatalog, explicitSkills, resolveWorkspaceRootAccess };
}

interface RunToolSurfaceInput {
  readonly input: ProductionCodingRuntimeResolverInput;
  readonly request: ProductionRuntimeBackendInput["request"];
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntime;
  readonly authority: CodingRuntimeAuthorityService;
  readonly research: ResearchComposition;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly signal: AbortSignal;
  readonly notifyVerifiedHeadAdvanced: (runId: string) => void;
}

// Reuses the SAME fields `managedResearchOptions`/`createManagedToolFacade` already source for the
// child-facing tool ports below (never a second, parallel policy source) so the gateway's outgoing
// advertisement and the actual dispatch-side ports agree on which optional tool is really available
// (#3384 wave-3 W3-1 redirect).
function unavailableOptionalToolsFor(
  input: ProductionCodingRuntimeResolverInput,
  minted: MintedRuntime,
  researchOptions: ReturnType<typeof managedResearchOptions>,
  skillCatalog: SkillCatalog,
): ReadonlySet<OpenCodeOptionalToolName> {
  return deriveOptionalToolAvailability({
    ...researchOptions,
    authorityRef: minted.authorityRef,
    skillCatalog,
    modelId: input.childModelId?.(),
    childModelPortFactory: input.childModelPortFactory,
  });
}

function createRunToolSurface(args: RunToolSurfaceInput): RunToolSurface {
  const { input, request, context, minted, authority, research, onRuntimeEvent } = args;
  const invocationRegistry = createCodingToolInvocationRegistry();
  const services = runtimeGitServices(
    input,
    context,
    minted,
    authority,
    args.signal,
    onRuntimeEvent,
    args.notifyVerifiedHeadAdvanced,
  );
  const { codingToolApprovals } = services;
  const { leases, skillCatalog, explicitSkills, resolveWorkspaceRootAccess } =
    prepareRunToolContext(input, request, context, invocationRegistry);
  const researchOptions = managedResearchOptions(input, context, minted, research, onRuntimeEvent);
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
    ...services,
    onRuntimeEvent,
    resolveWorkspaceRootAccess,
    researchOptions,
  });
  return {
    invocationRegistry,
    ciRepairBudget: services.ciRepairBudget,
    leases,
    explicitSkills,
    toolFacade,
    codingToolApprovals,
    resolveWorkspaceRootAccess,
    unavailableOptionalTools: () =>
      unavailableOptionalToolsFor(input, minted, researchOptions, skillCatalog),
  };
}

function createRunRecord(args: Omit<RunToolSurfaceInput, "signal">): ResolverRunRecord {
  const { input, request, context, minted, authority, research, onRuntimeEvent } = args;
  const controller = new AbortController();
  const surface = createRunToolSurface({ ...args, signal: controller.signal });
  const backend = createBackendRun({
    input,
    request,
    context,
    minted,
    ...surface,
    authority,
    controller,
    research,
    onRuntimeEvent,
  });
  const detachLease = attachRuntimeMutationLease(input, surface.leases, surface.invocationRegistry);
  return {
    manager: backend.manager,
    ciRepairBudget: surface.ciRepairBudget,
    launch: backend.launch,
    turnPort: bindExplicitSkillTurns(backend.turnPort, surface.explicitSkills),
    controller,
    operationGuard: createProductionRuntimeOperationGuard(request.runId, () =>
      runtimeAuthorityLive(input, context, minted, authority),
    ),
    waitForPendingMutations: (signal) => surface.leases.waitForIdle(signal),
    ...(backend.questionPort ? { questionPort: backend.questionPort } : {}),
    ...(backend.permissionPort ? { permissionPort: backend.permissionPort } : {}),
    toolBridge: backend.toolBridge,
    dispose: createRunDisposer(detachLease, surface.leases, surface.invocationRegistry, backend),
    unavailableOptionalTools: surface.unavailableOptionalTools,
  };
}

// ADR-0043 D11-D14 (#3390): registers this run's tool bridge as "the current" one the BFF route
// dispatches to, and wraps disposal so it clears itself -- identity-guarded so a disposal that
// settles after a NEWER run has already composed its own bridge can never clear the newer one.
// Kept outside `createRunRecord`/`createRunDisposer` (AGENTS.md §6's 50-line ceiling) since only
// `launchResolver`'s `resolve` closure, where the record is about to be stored, needs it.
function withCurrentToolFacadeBridge(
  record: ResolverRunRecord,
  toolFacadeBridge: { current: OpenCodeToolBridge | undefined },
): ResolverRunRecord {
  toolFacadeBridge.current = record.toolBridge;
  const dispose = record.dispose;
  return {
    ...record,
    dispose: async (): Promise<void> => {
      if (toolFacadeBridge.current === record.toolBridge) toolFacadeBridge.current = undefined;
      await dispose?.();
    },
  };
}

function runWorkspaceRootAccessResolver(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
): () => WorkspaceRootAccess | undefined {
  return (): WorkspaceRootAccess | undefined => {
    const access = input.resolveWorkspaceRootAccess(context.workspaceRoot);
    return access?.kind === "managed-task" && access.canonicalRoot === context.workspaceRoot
      ? access
      : undefined;
  };
}

export function bindExplicitSkillTurns(
  turnPort: ProductionRuntimeTurnPort,
  explicitSkills: ExplicitSkillInvocationTracker,
): ProductionRuntimeTurnPort {
  return {
    submitTurn: async (runId, text, initialContext): Promise<boolean> => {
      explicitSkills.observeTurn(text);
      const accepted = await turnPort.submitTurn(runId, text, initialContext);
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
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
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
  resolveWorkspaceRootAccess,
}: CreateBackendRunInput): QualifiedProductionRuntimeRun {
  const backend = input.backend.createRun({
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
    // A proof that could not run (IDENTITY_PROOF_FAILED, logged at its source) reads as "not
    // current": the runtime must not keep acting on a workspace the product cannot verify.
    workspaceIsCurrent: (): boolean => {
      try {
        return (
          input.workspaceAuthority.workspaceLifecycle.getActive()?.instance.workspaceId ===
          context.workspaceId
        );
      } catch (error) {
        if (isIdentityProofFailure(error)) return false;
        throw error;
      }
    },
    resolveWorkspaceRootAccess,
  });
  validateBackendLaunch(backend.launch, context);
  return backend;
}

/** One parameter object: the facade needs the whole run context, not an argument list to mis-order. */
interface ManagedToolFacadeInput {
  readonly ciRepairBudget?: CiRepairExecutionBudget | undefined;
  readonly ciObservationService?: CiObservationService | undefined;
  readonly draftDeliveryService?: DraftDeliveryService | undefined;
  readonly verifiedCommitService?: VerifiedCommitService | undefined;
  readonly runtimeGitService?: RuntimeGitService | undefined;
  readonly input: ProductionCodingRuntimeResolverInput;
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: MintedRuntime;
  readonly authority: CodingRuntimeAuthorityService;
  readonly invocationRegistry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly leases: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  readonly research: ResearchComposition;
  readonly researchOptions?: ReturnType<typeof managedResearchOptions> | undefined;
  readonly skillCatalog: SkillCatalog;
  readonly explicitSkills: ExplicitSkillInvocationTracker;
  readonly codingToolApprovals: CodingToolApprovalBridge;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
}

function runtimeGitFacadeOptions({
  ciObservationService,
  verifiedCommitService,
  runtimeGitService,
  draftDeliveryService,
  onRuntimeEvent,
}: Pick<
  ManagedToolFacadeInput,
  | "verifiedCommitService"
  | "runtimeGitService"
  | "draftDeliveryService"
  | "ciObservationService"
  | "onRuntimeEvent"
>): Pick<
  import("./productionManagedWorktreeTools.js").ProductionManagedWorktreeToolInput,
  | "verifiedCommitService"
  | "runtimeGitService"
  | "requestStageApproval"
  | "requestCommitApproval"
  | "draftDeliveryService"
  | "requestDraftDeliveryApproval"
  | "ciObservationService"
> {
  return {
    ...(ciObservationService === undefined ? {} : { ciObservationService }),
    ...(verifiedCommitService === undefined ? {} : { verifiedCommitService }),
    ...(runtimeGitService === undefined ? {} : { runtimeGitService }),
    ...(draftDeliveryService === undefined ? {} : { draftDeliveryService }),
    requestDraftDeliveryApproval: (id): void => {
      requestDraftDeliveryApproval(draftDeliveryService, id, onRuntimeEvent);
    },
    requestStageApproval: (proposalId): void => {
      requestRuntimeStageApproval(runtimeGitService, proposalId, onRuntimeEvent);
    },
    requestCommitApproval: (proposalId): void => {
      requestVerifiedCommitApproval(verifiedCommitService, proposalId, onRuntimeEvent);
    },
  };
}

function createManagedToolFacade(options: ManagedToolFacadeInput): CodingToolFacade {
  const {
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
    resolveWorkspaceRootAccess,
  } = options;
  const childModelId = input.childModelId?.();
  return createProductionManagedWorktreeToolFacade({
    authority,
    ...(options.ciRepairBudget === undefined ? {} : { ciRepairBudget: options.ciRepairBudget }),
    authorityRef: minted.authorityRef,
    taskId: context.taskId,
    // The child agent talks to the gateway directly, so it needs the resolved PROVIDER model id —
    // never the run's launch-profile identifier, which the gateway cannot resolve.
    ...(childModelId === undefined ? {} : { modelId: childModelId }),
    adapterKind: adapterKind(context),
    workspaceRoot: context.workspaceRoot,
    resolveWorkspaceRootAccess,
    ...(options.researchOptions ??
      managedResearchOptions(input, context, minted, research, onRuntimeEvent)),
    authorityExpiresAt: context.expiresAt,
    effectiveMode: minted.effectiveMode,
    effectiveModeNow: () => authority.effectiveMode(),
    reservePromptTokens: managedPromptReservation(options),
    deploymentCeiling: context.deploymentCeiling,
    liveFacts: () => productionRuntimeAuthorityFacts(input.workspaceAuthority, context),
    secureWorkspaceTextRead: input.secureWorkspaceTextRead,
    editorAgentClient: input.editorAgentClient,
    mutationLeaseCoordinator: leases,
    invocationRegistry,
    approvalProofVerifier: codingToolApprovals,
    ...runtimeGitFacadeOptions(options),
    skillCatalog,
    explicitSkillInvocations: explicitSkills,
    childModelPortFactory: input.childModelPortFactory,
    ...(input.commandRunner === undefined ? {} : { commandRunner: input.commandRunner }),
    verificationRunner: input.verificationRunner,
    onRuntimeEvent,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

function managedPromptReservation(
  options: ManagedToolFacadeInput,
): (promptTokens: number) => boolean {
  return (promptTokens): boolean =>
    reservePromptWithCiRepair(
      options.authority,
      () => options.ciRepairBudget,
      options.minted.modelGatewayCapability,
      promptTokens,
    ).ok;
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

function runtimeMutationLive(
  input: ProductionCodingRuntimeResolverInput,
  context: CodingRuntimeTrustedContext,
  minted: MintedRuntime,
  authority: CodingRuntimeAuthorityService,
): boolean {
  try {
    return authority.revalidateCapabilityForMutation({
      capability: minted.toolFacadeCapability,
      adapterKind: adapterKind(context),
      liveFacts: productionRuntimeAuthorityFacts(input.workspaceAuthority, context),
      workspaceRoot: context.workspaceRoot,
      deploymentCeiling: context.deploymentCeiling,
      nowIso: runtimeNow(input).toISOString(),
    }).ok;
  } catch {
    return false;
  }
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
