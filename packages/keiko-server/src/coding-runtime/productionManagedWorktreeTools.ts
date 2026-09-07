import { createHash } from "node:crypto";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";
import { runDraftDeliveryRequest } from "./productionDraftDeliveryRuntime.js";
import type { DraftDeliveryService } from "../gitDelivery/draftDeliveryTypes.js";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import type { VerifiedCommitService } from "../gitDelivery/verifiedCommitTypes.js";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeEvent,
  EditorAgentGovernedAuthorityReference,
  VerificationKind,
  VerificationReport,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import { isVerificationFailureLocation } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";

import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import type { CommandRunnerManager } from "../command-runner.js";
import type {
  VerificationRunInput,
  VerificationRunnerManager,
} from "../editor/verificationRunner.js";
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import {
  contentFreeErrorClass,
  describeError,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  codingToolFullAccessDeliveryAllowed,
  createRuntimeCodingToolFacade,
  type CommitExecutionApproval,
} from "./codingToolAuthorityPort.js";
import type { GovernedVerificationReasonCode } from "./codingToolFacade.js";
import type { CodingToolApprovalProofVerifier } from "./codingToolApprovalBridge.js";
import type { CodingToolFacade, CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type {
  CodingToolGovernedPorts,
  GovernedCodingToolResult,
  GovernedCodingToolPort,
} from "./codingToolGovernedDelegate.js";
import {
  CODING_TOOL_VERIFICATION_FAILURE_MAX_LOCATIONS,
  type CodingToolVerificationFailure,
  type CodingToolVerificationResult,
} from "./codingToolIpc.js";
import {
  createCodingRepositorySearchHandler,
  type CodingRepositorySearchHandler,
} from "./codingRepositorySearchHandler.js";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { createProductionAuxiliaryPorts } from "./productionAuxiliaryPorts.js";
import {
  createExplicitSkillInvocationTracker,
  type ExplicitSkillInvocationTracker,
} from "./explicitSkillInvocation.js";
import { createResearchEgressPort, type ResearchFetch } from "./researchEgressPort.js";
import type { ResearchGrantRegistry } from "./researchGrantRegistry.js";
import { createServerApprovedSkillCatalog, type SkillCatalog } from "./skillCatalog.js";
import {
  createCodingToolReadEditPorts,
  type CodingToolReadEditPortDeps,
  type CodingToolReadEditPorts,
} from "./codingToolReadEditPorts.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import { MAX_APPROVAL_CHALLENGE_TTL_MS } from "./codingRuntimeOrchestrator.js";

const PROPOSAL_APPROVAL_POLL_MS = 25;

type ProposalApprovalWaitOutcome = "approved" | "cancelled" | "expired" | "unavailable";

interface ProposalApprovalProbe {
  readonly review: (proposalId: string) => unknown;
  readonly matchesApproval: (proposalId: string) => boolean;
}

export function waitForRuntimeProposalApproval(
  probe: ProposalApprovalProbe,
  proposalId: string,
  signal?: AbortSignal,
  onResolutionFailure?: (error: unknown) => void,
): Promise<ProposalApprovalWaitOutcome> {
  return new Promise((resolve) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout((): void => {
      finish("expired");
    }, MAX_APPROVAL_CHALLENGE_TTL_MS);
    const finish = (outcome: ProposalApprovalWaitOutcome): void => {
      if (interval === undefined) return;
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      interval = undefined;
      resolve(outcome);
    };
    const abort = (): void => {
      finish("cancelled");
    };
    const inspect = (): void => {
      try {
        if (signal?.aborted === true) finish("cancelled");
        else if (probe.review(proposalId) === undefined) finish("unavailable");
        else if (probe.matchesApproval(proposalId)) finish("approved");
      } catch (error) {
        // A live authority/workspace resolver may fail closed after the proposal was displayed.
        // Settle the bounded wait through its existing unavailable outcome; an exception escaping
        // this interval callback would be an uncaught process-level failure.
        onResolutionFailure?.(error);
        finish("unavailable");
      }
    };
    interval = setInterval(inspect, PROPOSAL_APPROVAL_POLL_MS);
    signal?.addEventListener("abort", abort, { once: true });
    inspect();
  });
}

export interface ProductionManagedWorktreeToolInput {
  readonly ciRepairBudget?: CiRepairExecutionBudget;
  readonly ciObservationService?: CiObservationService;
  readonly draftDeliveryService?: DraftDeliveryService;
  readonly requestDraftDeliveryApproval?: (proposalId: string) => void;
  readonly verifiedCommitService?: VerifiedCommitService;
  readonly runtimeGitService?: RuntimeGitService;
  readonly requestStageApproval?: (proposalId: string) => void;
  readonly requestCommitApproval?: (proposalId: string) => void;
  readonly authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  > &
    Partial<Pick<CodingRuntimeAuthorityService, "state">>;
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly taskId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly adapterKind?: CodingWorkbenchRuntimeAdapterKind | undefined;
  readonly workspaceRoot: string;
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
  readonly authorityExpiresAt: string;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly effectiveModeNow?: (() => CodingWorkbenchMode | undefined) | undefined;
  readonly reservePromptTokens?: ((promptTokens: number) => boolean) | undefined;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly liveFacts: () => CodingWorkbenchRuntimeAuthorityFacts;
  readonly secureWorkspaceTextRead: SecureWorkspaceTextReadPort;
  readonly editorAgentClient: CodingToolReadEditPortDeps["editorAgentClient"];
  readonly mutationLeaseCoordinator?: CodingToolReadEditPortDeps["mutationLeaseCoordinator"];
  readonly invocationRegistry: CodingToolInvocationRegistry;
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly skillCatalog?: SkillCatalog | undefined;
  readonly explicitSkillInvocations?: ExplicitSkillInvocationTracker | undefined;
  readonly childModelPortFactory?: ((modelId: string) => ModelPort | undefined) | undefined;
  readonly verificationRunner: Pick<VerificationRunnerManager, "runToReport">;
  readonly commandRunner?: Pick<CommandRunnerManager, "execute"> | undefined;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  /** Body-free activity-log sink for the H1 search handler; defaults to the process-wide log. */
  readonly activityLog?: ServerLogSink | undefined;
  // Present only when read-only public research (#2387) is activated for this run: the run-bound
  // grant registry and the gateway's outbound egress config (proxy/CA). When absent, the egress
  // authority stays the fail-closed stub, so a run without research can never reach the internet.
  readonly researchGrantRegistry?: ResearchGrantRegistry | undefined;
  readonly gatewayEgress?: (() => OutboundHttpEgressConfig | undefined) | undefined;
  // Raises the #2387 approval ask for a research URL that no live grant covers. Optional: without
  // it the egress port still fails closed, it just cannot open the approval loop.
  readonly requestResearchApproval?: ((url: URL) => void) | undefined;
  /** Explicit hermetic-test seam for the research transport. Production never supplies this. */
  readonly researchFetchImpl?: ResearchFetch | undefined;
}

// #3414-AC9: a real, non-fake per-run signal for whether an optional tool's handler/readiness/
// policy prerequisite is actually satisfied right now -- built from the SAME fields this
// composition root already uses to decide whether the real dispatch port is mounted or the
// fail-closed stub (`buildEgressAuthority`, `auxiliaryPorts`), never a second, parallel policy
// source. The caller feeds the result straight into `opencodeLaunchProfile.ts`'s
// `unavailableOptionalTools` and (once wired) `opencodeToolSchemas.ts`'s `handlerCoverage`, so an
// unready optional tool is ABSENT from what the model is told exists, not merely denied when
// called. Research readiness means the bounded approval-capable handler is fully bound; each URL
// still needs a live #2387 grant at execution time. Requiring a grant here would hide the only
// model-visible path that can request that grant and deadlock the ordinary first-use flow.
export type OptionalToolAvailabilityInput = Pick<
  ProductionManagedWorktreeToolInput,
  | "researchGrantRegistry"
  | "gatewayEgress"
  | "requestResearchApproval"
  | "activityLog"
  | "authorityRef"
  | "skillCatalog"
  | "modelId"
  | "childModelPortFactory"
>;

export interface ResolvedChildModelInput {
  readonly modelId?: string | undefined;
  readonly childModelPortFactory?: ((modelId: string) => ModelPort | undefined) | undefined;
}

export function deriveOptionalToolAvailability(
  input: OptionalToolAvailabilityInput,
): ReadonlySet<OpenCodeOptionalToolName> {
  const unavailable = new Set<OpenCodeOptionalToolName>();
  if (!hasResearchApprovalHandler(input)) unavailable.add("keiko_research_fetch");
  if ((input.skillCatalog ?? createServerApprovedSkillCatalog()).list().length === 0)
    unavailable.add("keiko_skill");
  if (!hasResolvableChildAgentModel(input)) unavailable.add("keiko_child_agent");
  return unavailable;
}

function hasResearchApprovalHandler(input: OptionalToolAvailabilityInput): boolean {
  if (input.researchGrantRegistry === undefined || input.gatewayEgress === undefined) {
    return false;
  }
  try {
    const hasApprovalPath = input.requestResearchApproval !== undefined;
    const hasLiveGrant =
      input.researchGrantRegistry.activeGrants(input.authorityRef.runId, Date.now()).length > 0;
    return input.gatewayEgress() !== undefined && (hasApprovalPath || hasLiveGrant);
  } catch (error) {
    logOptionalToolAvailabilityFailure(
      input,
      "keiko_research_fetch",
      "research-egress-config",
      error,
    );
    return false;
  }
}

function logOptionalToolAvailabilityFailure(
  input: OptionalToolAvailabilityInput,
  optionalTool: OpenCodeOptionalToolName,
  stage: "research-egress-config" | "child-model-resolution",
  error: unknown,
): void {
  (input.activityLog ?? processServerLogSink()).write({
    category: "gateway",
    op: "coding-runtime.tool-availability.failed",
    correlationId: isValidCorrelationId(input.authorityRef.runId)
      ? input.authorityRef.runId
      : UNKNOWN_CORRELATION_ID,
    level: "warn",
    errorKind: contentFreeErrorClass(error),
    extra: {
      runId: input.authorityRef.runId,
      optionalTool,
      stage,
      reason: "configuration-resolution-failed",
      frames: keikoStackFrames(error),
      causeChain: causeChain(error),
    },
  });
}

function resolvedChildModelPort(input: OptionalToolAvailabilityInput): ModelPort | undefined {
  const modelId = input.modelId;
  const factory = input.childModelPortFactory;
  if (modelId === undefined || modelId.length === 0 || factory === undefined) return undefined;
  try {
    return factory(modelId);
  } catch (error) {
    logOptionalToolAvailabilityFailure(input, "keiko_child_agent", "child-model-resolution", error);
    return undefined;
  }
}

// Prove the model is available when the run surface is built, then resolve it again for every
// readiness offer and dispatch. The production factory follows the live gateway-config generation;
// retaining this first port would keep removed providers and rotated credentials alive for the run.
export function resolveChildModelForRun(
  input: OptionalToolAvailabilityInput,
): ResolvedChildModelInput {
  const modelId = input.modelId;
  const model = resolvedChildModelPort(input);
  if (modelId === undefined || model === undefined) return {};
  return {
    modelId,
    childModelPortFactory: (requestedModelId): ModelPort | undefined =>
      requestedModelId === modelId ? resolvedChildModelPort(input) : undefined,
  };
}

function hasResolvableChildAgentModel(input: OptionalToolAvailabilityInput): boolean {
  return resolvedChildModelPort(input) !== undefined;
}

export function createProductionManagedWorktreeToolFacade(
  input: ProductionManagedWorktreeToolInput,
): CodingToolFacade {
  const readEdit = createReadEditPorts(input);
  return createRuntimeCodingToolFacade(
    input.authority,
    () => ({
      adapterKind: input.adapterKind ?? "model-gateway-sidecar",
      liveFacts: input.liveFacts(),
      workspaceRoot: input.workspaceRoot,
      deploymentCeiling: input.deploymentCeiling,
      nowIso: new Date().toISOString(),
      runId: input.authorityRef.runId,
      envelopeDigest: input.authorityRef.envelopeDigest,
      authorityExpiresAt: input.authorityExpiresAt,
      // F8 (#3413): the run's own correlation id (the same value `buildRepositorySearchPort`
      // already threads into its H1 search-handler invocation below), so the catalog facade
      // bridge's tool-catalog.* lifecycle lines join the rest of this run's activity log instead
      // of falling back to UNKNOWN_CORRELATION_ID.
      correlationId: input.authorityRef.runId,
    }),
    governedPorts(input, readEdit),
    {
      invocationRegistry: input.invocationRegistry,
      ...(input.ciRepairBudget === undefined ? {} : { ciRepairBudget: input.ciRepairBudget }),
      reserveEditDelegation: true,
      ...(input.approvalProofVerifier === undefined
        ? {}
        : { approvalProofVerifier: input.approvalProofVerifier }),
      // Reuses this composition root's own activity-log/diagnostics sinks (the same ones
      // `buildRepositorySearchPort`/`repositorySearchHandler` already use below) rather than the
      // bridge's process-wide default, so a caller observing `input.activityLog` sees catalog
      // lifecycle evidence too.
      ...(input.activityLog === undefined ? {} : { catalogActivityLog: input.activityLog }),
      ...(input.diagnostics === undefined ? {} : { catalogDiagnostics: input.diagnostics }),
      unavailableOptionalTools: () => deriveOptionalToolAvailability(input),
    },
  );
}

function createReadEditPorts(input: ProductionManagedWorktreeToolInput): CodingToolReadEditPorts {
  return createCodingToolReadEditPorts({
    activityLog: input.activityLog,
    secureWorkspaceTextRead: input.secureWorkspaceTextRead,
    editorAgentClient: input.editorAgentClient,
    resolveEditorActionContext: () => ({
      sessionId: `runtime-${input.authorityRef.runId}`,
      authorityRef: input.authorityRef,
      origin: "agent",
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.liveFacts().binding.workspaceId,
      workspaceRootDigest: input.liveFacts().binding.workspaceRootDigest,
      expiresAt: input.authorityExpiresAt,
    }),
    resolveRepositoryReadContext: () => ({
      runId: input.authorityRef.runId,
      envelopeDigest: input.authorityRef.envelopeDigest,
      workspaceId: input.liveFacts().binding.workspaceId,
      workspaceRootDigest: input.liveFacts().binding.workspaceRootDigest,
      expiresAt: input.authorityExpiresAt,
    }),
    resolveWorkspaceRoot: () => input.workspaceRoot,
    resolveWorkspaceRootAccess: input.resolveWorkspaceRootAccess,
    requiresEditorReview: () =>
      codingWorkbenchPolicyEffectFor(
        input.effectiveModeNow?.() ?? input.effectiveMode,
        "workspace-contained",
        "high",
      ) !== "allowed",
    // KEIKO-0469: opt in to defense-in-depth binding enforcement so that a mutationGuard reaching
    // read/discover/edit without a producer-binding is denied at the preflight boundary rather
    // than silently no-op'ing the workspace/run identity check. The paired authority port
    // (`createCodingToolAuthorityPort` with `requireProducerBinding: true`) already denies before
    // such a guard can be constructed; this is the second lock.
    enforceProducerBinding: true,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.mutationLeaseCoordinator
      ? { mutationLeaseCoordinator: input.mutationLeaseCoordinator }
      : {}),
  });
}

function governedPorts(
  input: ProductionManagedWorktreeToolInput,
  readEdit: CodingToolReadEditPorts,
): CodingToolGovernedPorts {
  const catalog = input.skillCatalog ?? createServerApprovedSkillCatalog();
  const failed = (): Promise<{ readonly status: "failed" }> =>
    Promise.resolve({ status: "failed" });
  return {
    ...readEdit,
    ...auxiliaryPorts(input, catalog),
    repositorySearch: buildRepositorySearchPort(input),
    commandRunner: buildCommandRunner(input),
    verificationRunner: buildVerificationRunner(input),
    gitAuthority: buildRuntimeGitPort(input),
    deliveryAuthority: buildVerifiedCommitPort(input),
    connectorAuthority: buildSidecarCapabilityPort<"connector">(
      input,
      "connector-authority-revoked",
    ),
    egressAuthority: buildEgressAuthority(input, failed),
  };
}

function buildRuntimeGitPort(
  input: ProductionManagedWorktreeToolInput,
): GovernedCodingToolPort<"git"> {
  return {
    execute: async (
      request,
      signal,
      guard,
    ): ReturnType<GovernedCodingToolPort<"git">["execute"]> => {
      if (signalAborted(signal) || !guard.check() || !live(input))
        return { status: "failed", reasonCode: "git-authority-revoked" };
      if (request.operation === "ci")
        return runCiObservation(input.ciObservationService, request.forceFresh);
      if (
        input.runtimeGitService === undefined ||
        request.operation === "read" ||
        request.operation === "write"
      )
        return { status: "failed", reasonCode: "capability-backend-unavailable" };
      const result = await input.runtimeGitService.execute(request, guard, signal);
      if (result === undefined) return { status: "failed", reasonCode: "git-authority-revoked" };
      const released = await releaseStageProposal(input, result, signal);
      return released === undefined
        ? { status: "failed", reasonCode: "git-authority-revoked" }
        : { status: "completed", git: released };
    },
  };
}

async function runCiObservation(
  service: CiObservationService | undefined,
  forceFresh: boolean | undefined,
): Promise<import("./codingToolGovernedDelegate.js").GovernedCodingToolResult> {
  if (service === undefined)
    return { status: "failed", reasonCode: "capability-backend-unavailable" };
  // Preserve the exact zero-argument call when the model omits forceFresh (#3388): an explicit
  // `undefined` argument is a different, observable call shape from no argument at all.
  const observation =
    forceFresh === undefined ? await service.observe() : await service.observe(forceFresh);
  return { status: "completed", ci: observation };
}

function requestStageReview(
  input: ProductionManagedWorktreeToolInput,
  result: import("@oscharko-dev/keiko-contracts").CodingRuntimeGitResult,
): void {
  if (result.kind === "stage" && result.status === "approval-required")
    input.requestStageApproval?.(result.proposalId);
}

async function releaseStageProposal(
  input: ProductionManagedWorktreeToolInput,
  result: import("@oscharko-dev/keiko-contracts").CodingRuntimeGitResult,
  signal: AbortSignal | undefined,
): Promise<import("@oscharko-dev/keiko-contracts").CodingRuntimeGitResult | undefined> {
  if (result.kind !== "stage" || result.status !== "approval-required") return result;
  requestStageReview(input, result);
  const service = input.runtimeGitService;
  if (service === undefined) return undefined;
  const outcome = await waitForRuntimeProposalApproval(
    service,
    result.proposalId,
    signal,
    (error) => {
      recordProposalApprovalResolutionFailure(input, "git-stage", result.proposalId, error);
    },
  );
  recordProposalApprovalWait(input, "git-stage", result.proposalId, outcome);
  return outcome === "approved" ? { ...result, status: "ready", reason: "none" } : undefined;
}

function buildVerifiedCommitPort(
  input: ProductionManagedWorktreeToolInput,
): GovernedCodingToolPort<"delivery"> {
  return {
    execute: async (
      request,
      signal,
      guard,
    ): ReturnType<GovernedCodingToolPort<"delivery">["execute"]> => {
      if (signalAborted(signal) || !guard.check() || !live(input))
        return { status: "failed", reasonCode: "delivery-authority-revoked" };
      return isDraftToolRequest(request)
        ? completeDraftDeliveryRequest(input, request, guard, signal)
        : completeVerifiedCommitRequest(input, request, guard, signal);
    },
  };
}

async function completeDraftDeliveryRequest(
  input: ProductionManagedWorktreeToolInput,
  request: Parameters<typeof runDraftDeliveryRequest>[1],
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<GovernedCodingToolResult> {
  const result = await runDraftDeliveryRequest(input, request, guard, signal);
  const proposal = result.status === "completed" ? result.draftDelivery : undefined;
  if (
    proposal?.status !== "recorded" ||
    (proposal.record.phase !== "push-proposed" && proposal.record.phase !== "pr-proposed")
  )
    return result;
  const service = input.draftDeliveryService;
  if (service === undefined) return { status: "failed", reasonCode: "delivery-authority-revoked" };
  return releaseDraftDeliveryProposal(input, request, guard, signal, service, proposal);
}

async function releaseDraftDeliveryProposal(
  input: ProductionManagedWorktreeToolInput,
  request: Parameters<typeof runDraftDeliveryRequest>[1],
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
  service: DraftDeliveryService,
  proposal: Extract<
    import("@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery").CodingRuntimeDeliveryResult,
    { readonly status: "recorded" }
  >,
): Promise<GovernedCodingToolResult> {
  const actionKind = proposal.record.phase === "push-proposed" ? "push" : "pull-request";
  if (
    service.review(proposal.record.proposalId) !== undefined &&
    fullAccessProposalReady(guard, request, proposal.record.proposalId)
  ) {
    recordPolicyAuthorizedProposal(input, actionKind, proposal.record.proposalId);
    return { status: "completed", draftDelivery: proposal, approvalDisposition: "ready" };
  }
  input.requestDraftDeliveryApproval?.(proposal.record.proposalId);
  const outcome = await waitForRuntimeProposalApproval(
    service,
    proposal.record.proposalId,
    signal,
    (error) => {
      recordProposalApprovalResolutionFailure(input, actionKind, proposal.record.proposalId, error);
    },
  );
  recordProposalApprovalWait(input, actionKind, proposal.record.proposalId, outcome);
  return outcome === "approved"
    ? { status: "completed", draftDelivery: proposal, approvalDisposition: "ready" }
    : { status: "failed", reasonCode: "delivery-authority-revoked" };
}

async function completeVerifiedCommitRequest(
  input: ProductionManagedWorktreeToolInput,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "delivery" }
  >,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<GovernedCodingToolResult> {
  const service = input.verifiedCommitService;
  if (service === undefined || request.intent !== "commit")
    return { status: "failed", reasonCode: "capability-backend-unavailable" };
  const result = await runCommitRequest(service, request, guard, signal);
  if (result === undefined) return { status: "failed", reasonCode: "delivery-authority-revoked" };
  if (result.status !== "approval-required") return { status: "completed", verifiedCommit: result };
  if (
    service.review(result.proposalId) !== undefined &&
    fullAccessProposalReady(guard, request, result.proposalId)
  ) {
    recordPolicyAuthorizedProposal(input, "commit", result.proposalId);
    return { status: "completed", verifiedCommit: result, approvalDisposition: "ready" };
  }
  input.requestCommitApproval?.(result.proposalId);
  const outcome = await waitForRuntimeProposalApproval(
    service,
    result.proposalId,
    signal,
    (error) => {
      recordProposalApprovalResolutionFailure(input, "commit", result.proposalId, error);
    },
  );
  recordProposalApprovalWait(input, "commit", result.proposalId, outcome);
  return outcome === "approved"
    ? { status: "completed", verifiedCommit: result, approvalDisposition: "ready" }
    : { status: "failed", reasonCode: "delivery-authority-revoked" };
}

function fullAccessProposalReady(
  guard: CodingToolMutationGuard,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "delivery" }
  >,
  proposalId: string,
): boolean {
  const envelope = guard.resolveParentAuthority?.();
  return (
    envelope !== undefined &&
    guard.check() &&
    codingToolFullAccessDeliveryAllowed(envelope, { ...request, phase: "execute", proposalId })
  );
}

function recordPolicyAuthorizedProposal(
  input: ProductionManagedWorktreeToolInput,
  actionKind: "commit" | "push" | "pull-request",
  proposalId: string,
): void {
  (input.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "coding-runtime.tool-result",
    correlationId: isValidCorrelationId(input.authorityRef.runId)
      ? input.authorityRef.runId
      : UNKNOWN_CORRELATION_ID,
    extra: { actionKind, proposalId, state: "proposal-ready", reason: "policy-authorized" },
  });
}

function recordProposalApprovalWait(
  input: ProductionManagedWorktreeToolInput,
  actionKind: "git-stage" | "commit" | "push" | "pull-request",
  proposalId: string,
  outcome: ProposalApprovalWaitOutcome,
): void {
  (input.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "coding-runtime.tool-result",
    correlationId: isValidCorrelationId(input.authorityRef.runId)
      ? input.authorityRef.runId
      : UNKNOWN_CORRELATION_ID,
    extra: {
      actionKind,
      proposalId,
      state: "approval-wait-settled",
      reason: outcome,
    },
  });
}

export function recordProposalApprovalResolutionFailure(
  input: Pick<ProductionManagedWorktreeToolInput, "activityLog" | "authorityRef" | "diagnostics">,
  actionKind: "git-stage" | "commit" | "push" | "pull-request",
  proposalId: string,
  error: unknown,
): void {
  const correlationId = isValidCorrelationId(input.authorityRef.runId)
    ? input.authorityRef.runId
    : UNKNOWN_CORRELATION_ID;
  (input.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "coding-runtime.tool-result",
    correlationId,
    level: "warn",
    errorKind: contentFreeErrorClass(error),
    extra: {
      actionKind,
      proposalId,
      state: "approval-wait-failed",
      reason: "authority-resolution-failed",
      frames: keikoStackFrames(error),
      causeChain: causeChain(error),
    },
  });
  emitServerDiagnostic(input.diagnostics, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.tool-result",
    source: "production-managed-worktree-tools.approval-wait",
    errorClass: contentFreeErrorClass(error),
    message: "runtime-approval-resolution-failed",
  });
}

function runCommitRequest(
  service: VerifiedCommitService,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "delivery" }
  >,
  guard: import("./codingToolFacadePorts.js").CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): ReturnType<VerifiedCommitService["execute"]> {
  if (request.phase === "propose" && request.message !== undefined)
    return service.propose(request.message);
  if (request.proposalId === undefined) return Promise.resolve(undefined);
  // In Ask/Supervised, `deliveryApproval` carries the unconsumed commit claim built by
  // codingToolAuthorityPort.ts. Full access deliberately has no claim; execute() combines its
  // trusted live-mode callback with this exact request guard before using policy authorization.
  const approval = guard.deliveryApproval as CommitExecutionApproval | undefined;
  return service.execute(request.proposalId, approval?.claim, { check: guard.check, signal });
}

function buildCommandRunner(
  input: ProductionManagedWorktreeToolInput,
): CodingToolGovernedPorts["commandRunner"] {
  const commandRunner = input.commandRunner;
  if (commandRunner === undefined) {
    return unavailablePort("command-backend-unavailable");
  }
  return {
    execute: async (
      request,
      signal,
      guard,
    ): ReturnType<CodingToolGovernedPorts["commandRunner"]["execute"]> => {
      if (signalAborted(signal) || !guard.check() || !live(input)) {
        return { status: "failed", reasonCode: "command-authority-revoked" };
      }
      const result = await commandRunner.execute({
        projectId: input.workspaceRoot,
        taskId: request.commandId,
        requestId: request.actionId,
        signal,
        timeoutMs: guard.resolveParentAuthority?.()?.commandPolicy.maxCommandTimeoutMs,
      });
      if (result.failureReason !== "none") {
        return { status: "failed", reasonCode: "command-execution-failed" };
      }
      if (signalAborted(signal) || !guard.check() || !live(input)) {
        return { status: "failed", reasonCode: "command-authority-revoked" };
      }
      return { status: "completed" };
    },
  };
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// H1 (#3386): the bounded in-process content-search/ranged-read handler, mounted on the same
// managed-worktree resolver and liveness guard as every other governed read-class port. The
// workspace is (re)detected per call — never cached at facade construction — so a mid-run
// workspace-root change is observed exactly as `discoveryWorkspace()` (codingToolReadEditPorts.ts)
// already observes it for read/discover.
function buildRepositorySearchPort(
  input: ProductionManagedWorktreeToolInput,
): GovernedCodingToolPort<"search"> {
  return {
    execute: async (
      request,
      signal,
      guard,
    ): ReturnType<GovernedCodingToolPort<"search">["execute"]> => {
      if (signalAborted(signal) || !guard.check() || !live(input)) {
        return { status: "failed", reasonCode: "search-authority-revoked" };
      }
      const handler = repositorySearchHandler(input, guard, signal);
      if (handler?.readiness() !== "ready") {
        return { status: "failed", reasonCode: "capability-backend-unavailable" };
      }
      const result = await handler.invoke(request.repositoryRequest, {
        correlationId: input.authorityRef.runId,
        signal: signal ?? new AbortController().signal,
      });
      return { status: "completed", search: result };
    },
  };
}

function repositorySearchHandler(
  input: ProductionManagedWorktreeToolInput,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): CodingRepositorySearchHandler | undefined {
  const access = input.resolveWorkspaceRootAccess();
  if (access === undefined) return undefined;
  return createCodingRepositorySearchHandler({
    workspace: detectWorkspaceAt(access.canonicalRoot, access.fs),
    fs: access.fs,
    isCurrent: (): boolean => !signalAborted(signal) && guard.check() && live(input),
    log: input.activityLog ?? processServerLogSink(),
  });
}

function buildSidecarCapabilityPort<Kind extends "git" | "delivery" | "connector">(
  input: ProductionManagedWorktreeToolInput,
  revokedReason: string,
): GovernedCodingToolPort<Kind> {
  return {
    execute: (_request, signal, guard): ReturnType<GovernedCodingToolPort<Kind>["execute"]> => {
      if (signal?.aborted === true || !guard.check() || !live(input)) {
        return Promise.resolve({ status: "failed", reasonCode: revokedReason });
      }
      return Promise.resolve({ status: "failed", reasonCode: "capability-backend-unavailable" });
    },
  };
}

function unavailablePort<Kind extends "command" | "git" | "delivery" | "connector">(
  reasonCode: string,
): GovernedCodingToolPort<Kind> {
  return {
    execute: (): ReturnType<GovernedCodingToolPort<Kind>["execute"]> =>
      Promise.resolve({ status: "failed", reasonCode }),
  };
}

// The #2387 skill and read-only child-agent ports. Every identity field is resolved from the live
// run so a child can never outlive or out-scope the authority that spawned it.
function auxiliaryPorts(
  input: ProductionManagedWorktreeToolInput,
  catalog: SkillCatalog,
): ReturnType<typeof createProductionAuxiliaryPorts> {
  return createProductionAuxiliaryPorts({
    authority: {
      state: () =>
        input.authority.state?.() ?? {
          schemaVersion: "1" as const,
          state: "running" as const,
          revision: 0,
          updatedAt: new Date().toISOString(),
          runId: input.authorityRef.runId,
        },
    },
    reservePromptTokens: input.reservePromptTokens ?? ((): boolean => false),
    taskId: input.taskId ?? input.authorityRef.runId,
    runId: input.authorityRef.runId,
    workspaceId: () => input.liveFacts().binding.workspaceId,
    workspaceRoot: input.workspaceRoot,
    resolveWorkspaceRootAccess: input.resolveWorkspaceRootAccess,
    // Empty means "no coding-safe provider model resolved": the child-agent port then stays
    // unmounted (fail closed) instead of running a child against an unusable model id.
    modelId: input.modelId ?? "",
    authorityExpiresAt: input.authorityExpiresAt,
    catalog,
    explicitSkills: input.explicitSkillInvocations ?? createExplicitSkillInvocationTracker(catalog),
    modelPortFactory: input.childModelPortFactory ?? ((): undefined => undefined),
    secureWorkspaceTextRead: input.secureWorkspaceTextRead,
    researchGrantRegistry: input.researchGrantRegistry,
    emit: input.onRuntimeEvent,
    activityLog: input.activityLog ?? processServerLogSink(),
  });
}

// Liveness is re-checked both before the run and after the report lands, so a verification that
// completes after the authority expired is reported failed rather than completed.
type VerificationPortResult =
  | {
      readonly status: "completed";
      readonly verification?: CodingToolVerificationResult;
    }
  | {
      readonly status: "failed";
      readonly reasonCode?: string | undefined;
      readonly verificationFailure?: CodingToolVerificationFailure | undefined;
    };

// What a finished run that did not pass tells the model. Exhaustive by TYPE, not by convention:
// `Record<Exclude<VerificationStatus, "passed">, …>` stops compiling the day the contract gains an
// eighth status, so a new outcome can never silently inherit VERIFICATION_FAILED. Only a run that
// executed and went red is a red run — a wall-clock timeout and a resource ceiling name their own
// cause, and skipped/denied/cancelled never executed at all, so reporting them as a test failure
// sends the model back to code that is fine (PR #3381 review).
const VERIFICATION_OUTCOME_REASON_CODES: Readonly<
  Record<Exclude<VerificationStatus, "passed">, GovernedVerificationReasonCode>
> = {
  failed: "VERIFICATION_FAILED",
  "timed-out": "VERIFICATION_TIMED_OUT",
  "resource-exceeded": "VERIFICATION_RESOURCE_EXCEEDED",
  skipped: "VERIFICATION_NOT_RUN",
  denied: "VERIFICATION_NOT_RUN",
  cancelled: "VERIFICATION_NOT_RUN",
};

// A verification the runner REFUSED (no resolvable project, missing script trust, no runnable
// step) is not a red test run. Both used to reach the model as the same bare "failed" and left no
// log line, so the agent re-ran the verifier instead of reporting the blocker (workbench end-to-end
// run, 2026-09-03). The runner's closed error codes are forwarded and logged; a run that executed
// and did not pass says so with the code its own outcome earned. The two refusals BEFORE the runner
// is even called — authority or managed-workspace liveness already gone, and a verifier this server
// does not implement — carry their own codes for the same reason (cursor review, PR #3381): the
// model cannot tell "do not retry, report this" from "try again" out of a bare status.
function buildVerificationRunner(
  input: ProductionManagedWorktreeToolInput,
): CodingToolGovernedPorts["verificationRunner"] {
  let verificationSequence = 0;
  return {
    execute: async (request, signal, guard): Promise<VerificationPortResult> => {
      if (!guard.check() || !live(input)) {
        return verificationPortRefusal(input, "verification-authority-revoked");
      }
      const kind = verificationKind(request.verifierId);
      if (kind === undefined) {
        return verificationPortRefusal(input, "verification-verifier-unsupported");
      }
      let report: VerificationReport;
      let ticket: object | undefined;
      let commitProof: CodingToolVerificationResult | undefined;
      try {
        ticket = await input.verifiedCommitService?.beginVerification();
        if (!verificationCompletionLive(input, guard, signal)) {
          return verificationPortRefusal(input, "verification-authority-revoked");
        }
        report = await input.verificationRunner.runToReport(
          verificationRunInput(input, request, kind),
          signal ?? new AbortController().signal,
        );
        if (!verificationCompletionLive(input, guard, signal)) {
          return verificationPortRefusal(input, "verification-authority-revoked");
        }
        commitProof = await completeCandidateVerification(input, ticket, report, guard, signal);
      } catch (error) {
        return verificationRefused(input, error);
      }
      if (!verificationCompletionLive(input, guard, signal)) {
        return verificationPortRefusal(input, "verification-authority-revoked");
      }
      verificationSequence += 1;
      publishVerification(input, verificationSequence, report, request);
      return verificationOutcome(input, report, guard, signal, commitProof);
    },
  };
}

function verificationOutcome(
  input: ProductionManagedWorktreeToolInput,
  report: VerificationReport,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
  commitProof: CodingToolVerificationResult | undefined,
): VerificationPortResult {
  if (report.overallStatus !== "passed") {
    const verificationFailure = modelVerificationFailure(report);
    return {
      status: "failed",
      reasonCode: VERIFICATION_OUTCOME_REASON_CODES[report.overallStatus],
      ...(verificationFailure === undefined ? {} : { verificationFailure }),
    };
  }
  // A passing runner whose authority lapsed is a refusal, never a failed test run.
  return verificationCompletionLive(input, guard, signal)
    ? { status: "completed", ...(commitProof === undefined ? {} : { verification: commitProof }) }
    : verificationPortRefusal(input, "verification-authority-revoked");
}

function modelVerificationFailure(
  report: VerificationReport,
): CodingToolVerificationFailure | undefined {
  if (report.overallStatus !== "failed") return undefined;
  const failed = report.results.find((result) => result.status === "failed");
  if (failed === undefined) return undefined;
  const candidates = failed.locations ?? [];
  const locations = candidates
    .filter(isVerificationFailureLocation)
    .slice(0, CODING_TOOL_VERIFICATION_FAILURE_MAX_LOCATIONS);
  return {
    summary: `${failed.kind} failed; ${String(locations.length)} structured failure location${locations.length === 1 ? "" : "s"}`,
    locations,
    truncated: failed.truncated || candidates.length > locations.length,
  };
}

async function completeCandidateVerification(
  input: ProductionManagedWorktreeToolInput,
  ticket: object | undefined,
  report: VerificationReport,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<CodingToolVerificationResult | undefined> {
  if (input.verifiedCommitService === undefined) return undefined;
  if (ticket === undefined)
    return {
      commitProof: "unavailable",
      reasonCode: "candidate-not-staged",
      nextAction: "stage-then-verify",
    };
  const recorded = await input.verifiedCommitService.completeVerification(ticket, report, {
    check: guard.check,
    signal,
  });
  return recorded
    ? { commitProof: "recorded" }
    : { commitProof: "unavailable", reasonCode: "candidate-drift", nextAction: "verify-again" };
}
function verificationCompletionLive(
  input: ProductionManagedWorktreeToolInput,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): boolean {
  return !signalAborted(signal) && guard.check() && live(input);
}

// The runner keys its run-started/step/terminal evidence and its own "execution failed
// unexpectedly" diagnostic on `input.correlationId ?? <fresh uuid>`, so omitting the field left the
// two halves of one verification unjoinable: this file logged under the run id while the runner
// logged under a UUID nothing else carried, and `keiko support analyze --correlation-id <runId>`
// showed only half the operation (P2, PR #3381 review). The human route threads its request
// correlation the same way (verificationRoutes.ts).
function verificationRunInput(
  input: ProductionManagedWorktreeToolInput,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "verification" }
  >,
  kind: VerificationKind,
): VerificationRunInput {
  const correlationId = verificationCorrelationId(input);
  recordVerificationTarget(input, request, kind);
  return {
    projectId: input.workspaceRoot,
    kinds: [kind],
    requestId: request.actionId,
    ...(request.targetPath === undefined ? {} : { targetPath: request.targetPath }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function recordVerificationTarget(
  input: ProductionManagedWorktreeToolInput,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "verification" }
  >,
  kind: VerificationKind,
): void {
  if (request.targetPath === undefined) return;
  (input.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "coding-runtime.verification",
    correlationId: verificationCorrelationId(input) ?? UNKNOWN_CORRELATION_ID,
    extra: {
      state: "target-bound",
      verifierId: kind,
      targetCount: 1,
      targetPathSha256: createHash("sha256").update(request.targetPath, "utf8").digest("hex"),
    },
  });
}

// The run id is the timeline every verification line belongs to; the tool action id carries the
// sidecar's `session:call` shape, which is not a correlation id.
function verificationCorrelationId(input: ProductionManagedWorktreeToolInput): string | undefined {
  const runId = input.authorityRef.runId;
  return isValidCorrelationId(runId) ? runId : undefined;
}

function verificationPortRefusal(
  input: ProductionManagedWorktreeToolInput,
  reasonCode: "verification-authority-revoked" | "verification-verifier-unsupported",
): VerificationPortResult {
  emitVerificationDiagnostic(input, reasonCode, "verification-refused");
  return { status: "failed", reasonCode };
}

function emitVerificationDiagnostic(
  input: ProductionManagedWorktreeToolInput,
  errorClass: string,
  message: "verification-refused" | "verification-failed",
  error?: unknown,
): void {
  const detail = error === undefined ? undefined : describeError(error);
  emitServerDiagnostic(input.diagnostics, {
    correlationId: verificationCorrelationId(input) ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    source: "production-managed-worktree-tools.verification",
    errorClass,
    message,
    ...(detail?.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail?.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
    operation: "coding-runtime.verification",
  });
}

// `errorClass` reaches the `[keiko-server:diagnostic]` stderr line and the activity log's
// `errorKind` unredacted, and `Error.name` is a writable own property any library may assign a
// message or a path to. The repository already owns the hardening for that — `contentFreeErrorClass`
// admits a `.name` only from the specific built-in error names and otherwise falls back to the
// class declared in code — so a non-runner throw is classified through it rather than through raw
// `.name`, which is what the sibling read/edit port already does (PR #3381 review).
function verificationRefused(
  input: ProductionManagedWorktreeToolInput,
  error: unknown,
): VerificationPortResult {
  const code = error instanceof VerificationRunnerError ? error.code : undefined;
  emitVerificationDiagnostic(
    input,
    code ?? contentFreeErrorClass(error),
    code === undefined ? "verification-failed" : "verification-refused",
    error,
  );
  return code === undefined ? { status: "failed" } : { status: "failed", reasonCode: code };
}

// Mounts the real research-egress executor only when the run activated read-only research (registry
// and gateway egress both present); otherwise the egress authority stays the fail-closed stub, so a
// run without a research grant can never reach the internet.
function buildEgressAuthority(
  input: ProductionManagedWorktreeToolInput,
  failed: () => Promise<{ readonly status: "failed" }>,
): GovernedCodingToolPort<"egress"> {
  const registry = input.researchGrantRegistry;
  const gatewayEgress = input.gatewayEgress;
  if (registry === undefined || gatewayEgress === undefined) {
    return { execute: failed };
  }
  return createResearchEgressPort({
    registry,
    resolveRunId: (): string => input.authorityRef.runId,
    gatewayEgress: (): OutboundHttpEgressConfig | undefined => gatewayEgress(),
    emitEvent: input.onRuntimeEvent,
    ...(input.requestResearchApproval ? { onGrantMissing: input.requestResearchApproval } : {}),
    ...(input.researchFetchImpl ? { fetchImpl: input.researchFetchImpl } : {}),
    now: (): number => Date.now(),
  });
}

// The capability is plumbed to every governed port (read/edit, command, verification, git/delivery/
// connector, egress) specifically so liveness can be re-proven against the SAME resolver those ports
// use, not just an expiry timestamp. A lifecycle transition or gitdir-identity mismatch mid-run must
// revoke every one of those ports immediately, not only wait for authorityExpiresAt to lapse (#3347).
function live(input: ProductionManagedWorktreeToolInput): boolean {
  try {
    input.liveFacts();
    return (
      input.resolveWorkspaceRootAccess()?.kind === "managed-task" &&
      Date.now() < Date.parse(input.authorityExpiresAt)
    );
  } catch {
    return false;
  }
}

function publishVerification(
  input: ProductionManagedWorktreeToolInput,
  sequence: number,
  report: VerificationReport,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "verification" }
  >,
): void {
  const failure = modelVerificationFailure(report);
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: `event-verification-${String(sequence)}`,
    runId: input.authorityRef.runId,
    occurredAt: new Date().toISOString(),
    kind: "verification-summarized",
    verificationKind: "verification-command",
    verificationStatus: verificationStatus(report.overallStatus),
    passedCount: report.counts.passed,
    failedCount: failedCount(report),
    skippedCount: report.counts.skipped,
    failureLocationCount: failure?.locations.length ?? 0,
    failureLocationsTruncated: failure?.truncated ?? false,
    verificationTargetDigest: codingVerificationTargetDigest(
      request.verifierId,
      request.targetPath,
    ),
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok) {
    throw new Error("runtime-verification-event-invalid");
  }
  input.onRuntimeEvent(event);
}

export function codingVerificationTargetDigest(verifierId: string, targetPath?: string): string {
  return createHash("sha256")
    .update(verifierId, "utf8")
    .update("\0", "utf8")
    .update(targetPath ?? "", "utf8")
    .digest("hex");
}

function verificationStatus(
  overallStatus: VerificationReport["overallStatus"],
): "passed" | "partial" | "failed" {
  if (overallStatus === "passed") return "passed";
  if (overallStatus === "skipped") return "partial";
  return "failed";
}

function failedCount(report: VerificationReport): number {
  return (
    report.counts.failed +
    report.counts.denied +
    report.counts["timed-out"] +
    report.counts.cancelled +
    report.counts["resource-exceeded"]
  );
}

function verificationKind(value: string): VerificationKind | undefined {
  switch (value) {
    case "test":
    case "targeted-test":
    case "typecheck":
    case "lint":
    case "build":
      return value;
    default:
      return undefined;
  }
}
