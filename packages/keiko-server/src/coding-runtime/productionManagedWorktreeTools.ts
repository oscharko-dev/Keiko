import { createHash } from "node:crypto";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";
import { runDraftDeliveryRequest } from "./productionDraftDeliveryRuntime.js";
import type { DraftDeliveryService } from "../gitDelivery/draftDeliveryTypes.js";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type {
  RuntimeGitRefusalReason,
  RuntimeGitService,
} from "../gitDelivery/runtimeGitService.js";
import type {
  VerificationTicketOutcome,
  VerifiedCommitService,
} from "../gitDelivery/verifiedCommitTypes.js";
import type {
  CodingWorkbenchAuxiliaryStatus,
  CodingWorkbenchMode,
  CodingWorkbenchOperatorDecision,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeEvent,
  EditorAgentGovernedAuthorityReference,
  VerificationKind,
  VerificationReport,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  isVerificationFailureLocation,
  VERIFICATION_DEPENDENCY_FAILURE_STATES,
  VERIFICATION_TOOL_OPERATOR_DECISION_GRACE_MS,
} from "@oscharko-dev/keiko-contracts/runtime/verification";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import type { VerificationStepOutput } from "@oscharko-dev/keiko-verification";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";

import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import type { CommandRunnerManager } from "../command-runner.js";
import type {
  VerificationRunInput,
  VerificationRunnerManager,
} from "../editor/verificationRunner.js";
import {
  VerificationRunnerError,
  WorkspaceTrustRequiredError,
} from "../editor/verificationRunnerErrors.js";
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
  dependencyBootstrapFailureSummary,
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
  return boundedWait<ProposalApprovalWaitOutcome>({
    ceilingMs: MAX_APPROVAL_CHALLENGE_TTL_MS,
    intervalMs: PROPOSAL_APPROVAL_POLL_MS,
    expired: "expired",
    cancelled: "cancelled",
    threw: "unavailable",
    signal,
    inspect: (): ProposalApprovalWaitOutcome | undefined => {
      try {
        if (probe.review(proposalId) === undefined) return "unavailable";
        return probe.matchesApproval(proposalId) ? "approved" : undefined;
      } catch (error) {
        // A live authority/workspace resolver may fail closed after the proposal was displayed.
        // Settle the bounded wait through its existing unavailable outcome; an exception escaping
        // this interval callback would be an uncaught process-level failure.
        onResolutionFailure?.(error);
        return "unavailable";
      }
    },
  });
}

interface BoundedWaitInput<Outcome extends string> {
  readonly ceilingMs: number;
  readonly intervalMs: number;
  /** Settled when the ceiling passes with `inspect` never having answered. */
  readonly expired: Outcome;
  /** Settled when `signal` aborts first. */
  readonly cancelled: Outcome;
  /**
   * Settled when `inspect` throws. A probe that throws inside the interval callback would otherwise
   * reject nothing and leave the interval live — an uncaught process-level failure with the wait
   * never settling (CodeRabbit review, 2026-09-10).
   */
  readonly threw: Outcome;
  readonly signal?: AbortSignal | undefined;
  /** Probed once at once and then every interval; a value settles the wait, `undefined` keeps it. */
  readonly inspect: () => Outcome | undefined;
}

/**
 * The one bounded poll every in-place wait in this module is built on: a proposal awaiting its
 * approval and a verification awaiting the operator's package-script trust decision differ only in
 * what they probe and what the ceiling and abort mean to their caller. One skeleton means one
 * place where the interval, the ceiling timer and the abort listener are guaranteed to be released
 * together on every exit.
 */
function boundedWait<Outcome extends string>(input: BoundedWaitInput<Outcome>): Promise<Outcome> {
  return new Promise((resolve) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout((): void => {
      finish(input.expired);
    }, input.ceilingMs);
    const finish = (outcome: Outcome): void => {
      if (interval === undefined) return;
      clearInterval(interval);
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      interval = undefined;
      resolve(outcome);
    };
    const abort = (): void => {
      finish(input.cancelled);
    };
    const tick = (): void => {
      if (input.signal?.aborted === true) {
        finish(input.cancelled);
        return;
      }
      let outcome: Outcome | undefined;
      try {
        outcome = input.inspect();
      } catch {
        finish(input.threw);
        return;
      }
      if (outcome !== undefined) finish(outcome);
    };
    interval = setInterval(tick, input.intervalMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    tick();
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
  // `scriptTrustFor` is the runner's own package-script decision as a pure query, and is optional
  // for the same reason `requestOperatorDecision` is: a composition that supplies neither cannot
  // wait for an operator and keeps the immediate refusal it always had. Both are needed to wait.
  readonly verificationRunner: Pick<VerificationRunnerManager, "runToReport"> &
    Partial<Pick<VerificationRunnerManager, "scriptTrustFor">>;
  /**
   * Announces a decision only a local human can make, and then announces how it settled. A tool
   * that meets one waits in place for it; this is how the run itself reports that it is waiting,
   * so the operator sees a paused run naming the decision rather than a run that gave up. Absent
   * in a composition without a runtime event sink — the tool then fails closed exactly as before.
   */
  readonly requestOperatorDecision?: (
    decision: CodingWorkbenchOperatorDecision,
    outcome?: CodingWorkbenchAuxiliaryStatus,
  ) => void;
  readonly commandRunner?: Pick<CommandRunnerManager, "execute"> | undefined;
  /**
   * ADR-0147 D3, autonomous-delivery amendment (owner decision, 2026-09-10): records the worktree's
   * current `package.json` as a manifest this run's governed effect left behind, so the operator's
   * standing repository grant covers it for the rest of the run. Called after every completed edit
   * and command effect while the run's effective mode is `autonomous-delivery`, never in the two
   * modes that ask before risky work. Absent in a composition without the trust service.
   */
  readonly admitRunManifest?: (() => void) | undefined;
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
    editorChangeset: admittingRunManifest(readEdit.editorChangeset, input),
    ...auxiliaryPorts(input, catalog),
    repositorySearch: buildRepositorySearchPort(input),
    commandRunner: admittingRunManifest(buildCommandRunner(input), input),
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

// ADR-0147 D3, autonomous-delivery amendment (owner decision, 2026-09-10). In `autonomous-delivery`
// the operator has authorized this run to edit the workspace and verify it without per-action
// approval, so a `package.json` the run's own governed effect leaves behind is admitted for package
// scripts under the operator's standing repository grant (`WorkspaceScriptTrustService
// .admitRunManifest`); its scripts still run only under the verification runner's enforced egress
// isolation (ADR-0043), and the pull request carries the manifest diff to review before anything
// persists. The two modes that ask before risky work keep asking for a rewritten manifest. The
// admission is renewed after EVERY completed effect — edit or vetted command, since either may
// rewrite the manifest — so a manifest changed by anything else since (another process, the
// operator's editor) is the same drift the next verification refused before this amendment.
function admittingRunManifest<Kind extends "edit" | "command">(
  port: GovernedCodingToolPort<Kind>,
  input: ProductionManagedWorktreeToolInput,
): GovernedCodingToolPort<Kind> {
  const admit = input.admitRunManifest;
  if (admit === undefined) return port;
  return {
    execute: async (request, signal, guard): Promise<GovernedCodingToolResult> => {
      const result = await port.execute(request, signal, guard);
      if (result.status === "completed" && effectiveModeOf(input) === "autonomous-delivery")
        admit();
      return result;
    },
  };
}

function effectiveModeOf(input: ProductionManagedWorktreeToolInput): CodingWorkbenchMode {
  return input.effectiveModeNow?.() ?? input.effectiveMode;
}

// The facade's closed failure code for each reason the runtime Git service answers without a
// result (runtimeGitService.ts). Only `authority-revoked` may reach the model as a revoked
// authority: an unknown or expired proposal and a thrown Git failure used to collapse into that same
// code, and the model stopped delivering on the strength of it (Coding Workbench run 13, 2026-09-10).
const GIT_REFUSAL_REASON_CODES: Readonly<Record<RuntimeGitRefusalReason, string>> = {
  "authority-revoked": "git-authority-revoked",
  "proposal-unknown": "git-proposal-unknown",
  "execution-failed": "git-execution-failed",
};

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
      if (result.kind === "refused")
        return { status: "failed", reasonCode: GIT_REFUSAL_REASON_CODES[result.reason] };
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
      const entryRefusal = verificationLivenessRefusal(input, guard, signal);
      if (entryRefusal !== undefined) {
        return verificationPortRefusal(input, "verification-authority-revoked", entryRefusal);
      }
      const kind = verificationKind(request.verifierId);
      if (kind === undefined) {
        return verificationPortRefusal(input, "verification-verifier-unsupported");
      }
      // Taken at entry, right after the catalog armed its settlement timer: the registry's and the
      // catalog's ceilings both run from admission, so the wait below must be measured from here
      // and not from the moment the first attempt failed (owner review, PR #3452).
      const enteredAtMs = Date.now();
      let attempt = await runVerificationAttempt(input, request, kind, guard, signal);
      if (attempt.outcome === "threw" && attempt.error instanceof WorkspaceTrustRequiredError) {
        if (await settleWorkspaceScriptTrust(input, signal, enteredAtMs)) {
          attempt = await runVerificationAttempt(input, request, kind, guard, signal);
        }
      }
      if (attempt.outcome === "refused") return attempt.result;
      if (attempt.outcome === "threw") return verificationRefused(input, attempt.error);
      const completionRefusal = verificationLivenessRefusal(input, guard, signal);
      if (completionRefusal !== undefined) {
        return verificationPortRefusal(input, "verification-authority-revoked", completionRefusal);
      }
      verificationSequence += 1;
      publishVerification(input, verificationSequence, attempt.report, request);
      return verificationOutcome(input, attempt, guard, signal);
    },
  };
}

type VerificationAttempt =
  | { readonly outcome: "refused"; readonly result: VerificationPortResult }
  | {
      readonly outcome: "completed";
      readonly report: VerificationReport;
      readonly failureOutput: readonly VerificationStepOutput[];
      readonly commitProof: CodingToolVerificationResult | undefined;
    }
  | { readonly outcome: "threw"; readonly error: unknown };

/**
 * One whole attempt at the verification effect, extracted so it can be made a second time after an
 * operator's package-script trust decision. Extracting it rather than retrying `runToReport` alone
 * is deliberate: the candidate-verification ticket and the liveness re-checks bracket the run, and
 * a retry that reused the first attempt's ticket would attribute the second run's report to the
 * first run's commit candidate.
 */
async function runVerificationAttempt(
  input: ProductionManagedWorktreeToolInput,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "verification" }
  >,
  kind: VerificationKind,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<VerificationAttempt> {
  // Built on demand, never in advance: `verificationPortRefusal` EMITS the refusal diagnostic as a
  // side effect, so materialising it up front would report a revoked authority on every attempt
  // that then succeeded.
  const revoked = (condition: VerificationLivenessRefusal): VerificationAttempt => ({
    outcome: "refused",
    result: verificationPortRefusal(input, "verification-authority-revoked", condition),
  });
  try {
    const begun = await input.verifiedCommitService?.beginVerification();
    const beforeRun = verificationLivenessRefusal(input, guard, signal);
    if (beforeRun !== undefined) return revoked(beforeRun);
    const { report, failureOutput } = await input.verificationRunner.runToReport(
      verificationRunInput(input, request, kind),
      signal ?? new AbortController().signal,
    );
    const afterRun = verificationLivenessRefusal(input, guard, signal);
    if (afterRun !== undefined) return revoked(afterRun);
    const commitProof = await completeCandidateVerification(input, begun, report, guard, signal);
    return { outcome: "completed", report, failureOutput, commitProof };
  } catch (error) {
    return { outcome: "threw", error };
  }
}

// ADR-0147 D3 refuses package scripts the operator has not allowed for these exact manifest bytes,
// and only the operator can change that. Before this the verification tool returned that refusal
// straight to the model, which — correctly following its own guidance — reported the blocker and
// stopped; run 10 of the Coding Workbench engagement then settled with nothing verified, committed
// or delivered, and no surface had ever told the operator a decision was waiting for them.
//
// The tool now waits in place for that decision, exactly as a git-stage or commit proposal already
// waits for its approval, and the run reports itself `paused` naming the decision. This is NOT the
// Authority Envelope approval plane: the decision is recorded on the workspace's own trust surface,
// mints no action authority, and is asked identically in all three autonomy modes because script
// trust is a hard, mode-independent boundary.
//
// The poll is slower than a proposal's: each probe resolves the workspace and re-reads the manifest
// bytes, and a human decision does not need 25 ms resolution.
const SCRIPT_TRUST_POLL_MS = 500;

/**
 * How long the tool waits: the share of a governed verification call that the contract reserves
 * for a human decision. A wait that ran to the five-minute approval ceiling would be settled
 * before it returned — by the governed-invocation registry's TTL and by the catalog descriptor's
 * duration bound, both 30 s today — as an opaque cancellation, and the model would lose the one
 * string that tells it what a person has to do. The co-located test pins this constant below the
 * registry's ceiling.
 *
 * This bounds the GRACE WINDOW, not the decision: an operator watching the Workbench sees the
 * notice the moment the run reports itself paused and can allow the scripts inside it, and the run
 * then continues with no interruption at all. A decision that does not arrive in the window is not
 * lost — the run stays paused naming it, and the model is handed the truthful refusal instead of a
 * silent success. A decision that outlives a single tool call is a separate mechanism this does not
 * claim to provide.
 */
export const SCRIPT_TRUST_WAIT_CEILING_MS = VERIFICATION_TOOL_OPERATOR_DECISION_GRACE_MS;

type ScriptTrustWaitOutcome = "granted" | "cancelled" | "expired" | "unavailable";

const SCRIPT_TRUST_WAIT_OUTCOMES: Readonly<
  Record<ScriptTrustWaitOutcome, CodingWorkbenchAuxiliaryStatus>
> = Object.freeze({
  granted: "accepted",
  cancelled: "stopped",
  expired: "limit-reached",
  unavailable: "unavailable",
});

export function waitForWorkspaceScriptTrust(
  probe: () => { readonly trusted: boolean } | undefined,
  signal?: AbortSignal,
  ceilingMs: number = SCRIPT_TRUST_WAIT_CEILING_MS,
): Promise<ScriptTrustWaitOutcome> {
  return boundedWait<ScriptTrustWaitOutcome>({
    ceilingMs,
    intervalMs: SCRIPT_TRUST_POLL_MS,
    expired: "expired",
    cancelled: "cancelled",
    threw: "unavailable",
    signal,
    inspect: (): ScriptTrustWaitOutcome | undefined => {
      const decision = probe();
      // An unresolvable workspace is not a verdict: it can never become a grant, so waiting on a
      // human for it would hang the run for the full ceiling with nothing to decide.
      if (decision === undefined) return "unavailable";
      return decision.trusted ? "granted" : undefined;
    },
  });
}

/**
 * Announces the open decision, waits for it, announces how it settled, and reports whether the
 * caller may try the effect again. The decision is announced BEFORE the wait's first probe, so the
 * run reports itself paused for the whole window an operator could decide in.
 */
async function settleWorkspaceScriptTrust(
  input: ProductionManagedWorktreeToolInput,
  signal: AbortSignal | undefined,
  enteredAtMs: number,
): Promise<boolean> {
  const { requestOperatorDecision } = input;
  const scriptTrustFor = input.verificationRunner.scriptTrustFor;
  if (requestOperatorDecision === undefined || scriptTrustFor === undefined) return false;
  // What is LEFT of the grace window once the first attempt has spent its share: the invocation's
  // own ceilings run from admission, so a wait that always took the full window after a slow
  // first attempt would be settled by them first as an opaque cancellation.
  const ceilingMs = Math.max(0, SCRIPT_TRUST_WAIT_CEILING_MS - (Date.now() - enteredAtMs));
  requestOperatorDecision("workspace-script-trust");
  const outcome = await waitForWorkspaceScriptTrust(
    () => scriptTrustFor(input.workspaceRoot),
    signal,
    ceilingMs,
  );
  requestOperatorDecision("workspace-script-trust", SCRIPT_TRUST_WAIT_OUTCOMES[outcome]);
  recordScriptTrustWait(input, outcome, ceilingMs);
  return outcome === "granted";
}

function recordScriptTrustWait(
  input: ProductionManagedWorktreeToolInput,
  outcome: ScriptTrustWaitOutcome,
  waitCeilingMs: number,
): void {
  (input.activityLog ?? processServerLogSink()).write({
    level: outcome === "granted" ? "info" : "warn",
    category: "process",
    op: "coding-runtime.operator-decision",
    correlationId: verificationCorrelationId(input) ?? UNKNOWN_CORRELATION_ID,
    extra: {
      decision: "workspace-script-trust",
      state: "settled",
      reason: outcome,
      waitCeilingMs,
      pollIntervalMs: SCRIPT_TRUST_POLL_MS,
    },
  });
}

function verificationOutcome(
  input: ProductionManagedWorktreeToolInput,
  attempt: Extract<VerificationAttempt, { readonly outcome: "completed" }>,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): VerificationPortResult {
  const { report, commitProof } = attempt;
  if (report.overallStatus !== "passed") {
    const verificationFailure = modelVerificationFailure(report, attempt.failureOutput);
    return {
      status: "failed",
      reasonCode: VERIFICATION_OUTCOME_REASON_CODES[report.overallStatus],
      ...(verificationFailure === undefined ? {} : { verificationFailure }),
    };
  }
  // A passing runner whose authority lapsed is a refusal, never a failed test run.
  const refusal = verificationLivenessRefusal(input, guard, signal);
  return refusal === undefined
    ? { status: "completed", ...(commitProof === undefined ? {} : { verification: commitProof }) }
    : verificationPortRefusal(input, "verification-authority-revoked", refusal);
}

// What the model is told about a run that did not pass: the failed step's structured locations
// when the parser could read them, and always the orchestrator's redacted output tail for that
// step (ADR-0126 D3) — a missing binary, a bundler error or npm's own diagnostics carry no
// location, and without the tail the model repaired nothing (Coding Workbench run 15, 2026-09-10).
// A failed dependency bootstrap is named as such, with its own tail.
function modelVerificationFailure(
  report: VerificationReport,
  failureOutput: readonly VerificationStepOutput[] = [],
): CodingToolVerificationFailure | undefined {
  if (report.overallStatus !== "failed") return undefined;
  const dependencies = report.dependencies;
  if (
    dependencies !== undefined &&
    VERIFICATION_DEPENDENCY_FAILURE_STATES.has(dependencies.state)
  ) {
    return dependencyBootstrapFailure(dependencies, failureOutput);
  }
  return stepFailure(report, failureOutput);
}

function dependencyBootstrapFailure(
  dependencies: NonNullable<VerificationReport["dependencies"]>,
  failureOutput: readonly VerificationStepOutput[],
): CodingToolVerificationFailure {
  const excerpt = failureOutput.find((output) => output.step === "dependencies")?.excerpt;
  return {
    summary: dependencyBootstrapFailureSummary(dependencies.state),
    locations: [],
    truncated: false,
    ...(excerpt === undefined ? {} : { excerpt }),
    dependencies,
  };
}

function stepFailure(
  report: VerificationReport,
  failureOutput: readonly VerificationStepOutput[],
): CodingToolVerificationFailure | undefined {
  const failed = report.results.find((result) => result.status === "failed");
  if (failed === undefined) return undefined;
  const candidates = failed.locations ?? [];
  const locations = candidates
    .filter(isVerificationFailureLocation)
    .slice(0, CODING_TOOL_VERIFICATION_FAILURE_MAX_LOCATIONS);
  const excerpt = failureOutput.find(
    (output) => output.step === failed.kind && output.scriptName === failed.scriptName,
  )?.excerpt;
  return {
    summary: `${failed.kind} failed; ${String(locations.length)} structured failure location${locations.length === 1 ? "" : "s"}`,
    locations,
    truncated: failed.truncated || candidates.length > locations.length,
    ...(excerpt === undefined ? {} : { excerpt }),
  };
}

async function completeCandidateVerification(
  input: ProductionManagedWorktreeToolInput,
  begun: VerificationTicketOutcome | undefined,
  report: VerificationReport,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<CodingToolVerificationResult | undefined> {
  if (input.verifiedCommitService === undefined || begun === undefined) return undefined;
  if (begun.kind !== "ticket") {
    // Not a commit proof, but still a check the run ran: kept for the pull request's list (F57).
    input.verifiedCommitService.observeVerification(report);
    return {
      commitProof: "unavailable",
      reasonCode: "candidate-not-staged",
      nextAction: "stage-then-verify",
      // The paths the model has to stage (run 16, 2026-09-10); a vanished run context has none.
      ...(begun.kind === "refused" ? { blocking: begun.blocking } : {}),
    };
  }
  const recorded = await input.verifiedCommitService.completeVerification(begun.ticket, report, {
    check: guard.check,
    signal,
  });
  return recorded
    ? { commitProof: "recorded" }
    : { commitProof: "unavailable", reasonCode: "candidate-drift", nextAction: "verify-again" };
}
export type VerificationLivenessRefusal = "signal-aborted" | "guard-rejected" | "run-not-live";

/**
 * Which of the three liveness conditions a verification effect fails, or undefined while all hold.
 * One closed code (`verification-authority-revoked`) answers the model for all three, and until run
 * 12 (2026-09-10) the refusal diagnostic said no more than that: a concurrent verification refused
 * while its sibling waited on the operator's trust decision left no way to tell an aborted signal
 * from a rejecting guard from a workspace that had stopped resolving. The condition is now the
 * diagnostic's `code`, so the log names the one that fired.
 */
export function verificationLivenessRefusal(
  input: Pick<
    ProductionManagedWorktreeToolInput,
    "liveFacts" | "resolveWorkspaceRootAccess" | "authorityExpiresAt"
  >,
  guard: Pick<CodingToolMutationGuard, "check">,
  signal: AbortSignal | undefined,
): VerificationLivenessRefusal | undefined {
  if (signalAborted(signal)) return "signal-aborted";
  if (!guard.check()) return "guard-rejected";
  if (!live(input)) return "run-not-live";
  return undefined;
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
  condition?: VerificationLivenessRefusal,
): VerificationPortResult {
  emitVerificationDiagnostic(input, reasonCode, "verification-refused", undefined, condition);
  return { status: "failed", reasonCode };
}

function emitVerificationDiagnostic(
  input: ProductionManagedWorktreeToolInput,
  errorClass: string,
  message: "verification-refused" | "verification-failed",
  error?: unknown,
  code?: string,
): void {
  const detail = error === undefined ? undefined : describeError(error);
  const closedCode = code ?? detail?.code;
  emitServerDiagnostic(input.diagnostics, {
    correlationId: verificationCorrelationId(input) ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    source: "production-managed-worktree-tools.verification",
    errorClass,
    message,
    // A coded throw (the raw status reader's `git-raw-snapshot-incomplete`, for one) names its closed
    // reason here; before 2026-09-10 the line carried `errorKind: "Error"` and nothing else.
    ...(closedCode === undefined ? {} : { code: closedCode }),
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
function live(
  input: Pick<
    ProductionManagedWorktreeToolInput,
    "liveFacts" | "resolveWorkspaceRootAccess" | "authorityExpiresAt"
  >,
): boolean {
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
