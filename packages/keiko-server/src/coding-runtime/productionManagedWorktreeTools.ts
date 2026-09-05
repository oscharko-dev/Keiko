import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
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
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { createRuntimeCodingToolFacade } from "./codingToolAuthorityPort.js";
import type { GovernedVerificationReasonCode } from "./codingToolFacade.js";
import type { CodingToolApprovalProofVerifier } from "./codingToolApprovalBridge.js";
import type { CodingToolFacade, CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type {
  CodingToolGovernedPorts,
  GovernedCodingToolPort,
} from "./codingToolGovernedDelegate.js";
import {
  createCodingRepositorySearchHandler,
  type CodingRepositorySearchHandler,
} from "./codingRepositorySearchHandler.js";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/server-log.js";
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
    }),
    governedPorts(input, readEdit),
    {
      invocationRegistry: input.invocationRegistry,
      ...(input.ciRepairBudget === undefined ? {} : { ciRepairBudget: input.ciRepairBudget }),
      reserveEditDelegation: true,
      ...(input.approvalProofVerifier === undefined
        ? {}
        : { approvalProofVerifier: input.approvalProofVerifier }),
    },
  );
}

function createReadEditPorts(input: ProductionManagedWorktreeToolInput): CodingToolReadEditPorts {
  return createCodingToolReadEditPorts({
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
      requestStageReview(input, result);
      return { status: "completed", git: result };
    },
  };
}

async function runCiObservation(
  service: CiObservationService | undefined,
  forceFresh: boolean | undefined,
): Promise<import("./codingToolGovernedDelegate.js").GovernedCodingToolResult> {
  if (service === undefined) return { status: "failed", reasonCode: "capability-backend-unavailable" };
  // Preserve the exact zero-argument call when the model omits forceFresh (#3388): an explicit
  // `undefined` argument is a different, observable call shape from no argument at all.
  const observation = forceFresh === undefined ? await service.observe() : await service.observe(forceFresh);
  return { status: "completed", ci: observation };
}

function requestStageReview(
  input: ProductionManagedWorktreeToolInput,
  result: import("@oscharko-dev/keiko-contracts").CodingRuntimeGitResult,
): void {
  if (result.kind === "stage" && result.status === "approval-required")
    input.requestStageApproval?.(result.proposalId);
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
      if (isDraftToolRequest(request))
        return runDraftDeliveryRequest(input, request, guard, signal);
      const service = input.verifiedCommitService;
      if (service === undefined || request.intent !== "commit")
        return { status: "failed", reasonCode: "capability-backend-unavailable" };
      const result = await runCommitRequest(service, request, guard, signal);
      if (result === undefined)
        return { status: "failed", reasonCode: "delivery-authority-revoked" };
      if (result.status === "approval-required") input.requestCommitApproval?.(result.proposalId);
      return { status: "completed", verifiedCommit: result };
    },
  };
}
function runCommitRequest(
  service: VerifiedCommitService,
  request: Extract<
    import("./codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "delivery" }
  >,
  guard: import("./codingToolFacadePorts.js").CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): ReturnType<VerifiedCommitService["executeApproved"]> {
  if (request.phase === "propose" && request.message !== undefined)
    return service.propose(request.message);
  return request.proposalId === undefined || guard.deliveryApproval === undefined
    ? Promise.resolve(undefined)
    : service.executeApproved(request.proposalId, guard.deliveryApproval, {
        check: guard.check,
        signal,
      });
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
  });
}

// Liveness is re-checked both before the run and after the report lands, so a verification that
// completes after the authority expired is reported failed rather than completed.
type VerificationPortResult =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly reasonCode?: string | undefined };

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
      try {
        ticket = await input.verifiedCommitService?.beginVerification();
        if (!verificationCompletionLive(input, guard, signal)) {
          return verificationPortRefusal(input, "verification-authority-revoked");
        }
        report = await input.verificationRunner.runToReport(
          verificationRunInput(input, request.actionId, kind),
          signal ?? new AbortController().signal,
        );
        if (!verificationCompletionLive(input, guard, signal)) {
          return verificationPortRefusal(input, "verification-authority-revoked");
        }
        await completeCandidateVerification(input, ticket, report, guard, signal);
      } catch (error) {
        return verificationRefused(input, error);
      }
      if (!verificationCompletionLive(input, guard, signal)) {
        return verificationPortRefusal(input, "verification-authority-revoked");
      }
      verificationSequence += 1;
      publishVerification(input, verificationSequence, report);
      return verificationOutcome(input, report, guard, signal);
    },
  };
}

function verificationOutcome(
  input: ProductionManagedWorktreeToolInput,
  report: VerificationReport,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): VerificationPortResult {
  if (report.overallStatus !== "passed") {
    return {
      status: "failed",
      reasonCode: VERIFICATION_OUTCOME_REASON_CODES[report.overallStatus],
    };
  }
  // A passing runner whose authority lapsed is a refusal, never a failed test run.
  return verificationCompletionLive(input, guard, signal)
    ? { status: "completed" }
    : verificationPortRefusal(input, "verification-authority-revoked");
}

async function completeCandidateVerification(
  input: ProductionManagedWorktreeToolInput,
  ticket: object | undefined,
  report: VerificationReport,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ticket !== undefined)
    await input.verifiedCommitService?.completeVerification(ticket, report, {
      check: guard.check,
      signal,
    });
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
  requestId: string,
  kind: VerificationKind,
): VerificationRunInput {
  const correlationId = verificationCorrelationId(input);
  return {
    projectId: input.workspaceRoot,
    kinds: [kind],
    requestId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
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
): void {
  emitServerDiagnostic(input.diagnostics, {
    correlationId: verificationCorrelationId(input) ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.verification",
    source: "production-managed-worktree-tools.verification",
    errorClass,
    message,
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
): void {
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
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok) {
    throw new Error("runtime-verification-event-invalid");
  }
  input.onRuntimeEvent(event);
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
