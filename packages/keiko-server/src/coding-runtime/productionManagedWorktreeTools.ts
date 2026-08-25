import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  codingWorkbenchPolicyEffectFor,
  validateCodingWorkbenchRuntimeEvent,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeAdapterKind,
  type CodingWorkbenchRuntimeAuthorityFacts,
  type CodingWorkbenchRuntimeEvent,
  type EditorAgentGovernedAuthorityReference,
  type VerificationKind,
  type VerificationReport,
} from "@oscharko-dev/keiko-contracts";

import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import type { CommandRunnerManager } from "../command-runner.js";
import type { VerificationRunnerManager } from "../editor/verificationRunner.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import { createRuntimeCodingToolFacade } from "./codingToolAuthorityPort.js";
import type { CodingToolApprovalProofVerifier } from "./codingToolApprovalBridge.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import type {
  CodingToolGovernedPorts,
  GovernedCodingToolPort,
} from "./codingToolGovernedDelegate.js";
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

export interface ProductionManagedWorktreeToolInput {
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
    commandRunner: buildCommandRunner(input),
    verificationRunner: buildVerificationRunner(input),
    gitAuthority: buildSidecarCapabilityPort<"git">(input, "git-authority-revoked"),
    deliveryAuthority: buildSidecarCapabilityPort<"delivery">(
      input,
      "delivery-authority-revoked",
    ),
    connectorAuthority: buildSidecarCapabilityPort<"connector">(
      input,
      "connector-authority-revoked",
    ),
    egressAuthority: buildEgressAuthority(input, failed),
  };
}

function buildCommandRunner(
  input: ProductionManagedWorktreeToolInput,
): CodingToolGovernedPorts["commandRunner"] {
  const commandRunner = input.commandRunner;
  if (commandRunner === undefined) {
    return unavailablePort("command-backend-unavailable");
  }
  return {
    execute: async (request, signal, guard): ReturnType<
      CodingToolGovernedPorts["commandRunner"]["execute"]
    > => {
      if (signal?.aborted === true || !guard.check() || !live(input)) {
        return { status: "failed", reasonCode: "command-authority-revoked" };
      }
      const result = await commandRunner.execute({
        projectId: input.workspaceRoot,
        taskId: request.commandId,
        requestId: request.actionId,
      });
      return result.failureReason === "none" && guard.check() && live(input)
        ? { status: "completed" }
        : { status: "failed", reasonCode: "command-execution-failed" };
    },
  };
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
  return { execute: (): ReturnType<GovernedCodingToolPort<Kind>["execute"]> => Promise.resolve({ status: "failed", reasonCode }) };
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
function buildVerificationRunner(
  input: ProductionManagedWorktreeToolInput,
): CodingToolGovernedPorts["verificationRunner"] {
  let verificationSequence = 0;
  return {
    execute: async (
      request,
      signal,
      guard,
    ): Promise<{ readonly status: "completed" | "failed" }> => {
      if (!guard.check() || !live(input)) return { status: "failed" };
      const kind = verificationKind(request.verifierId);
      if (kind === undefined) return { status: "failed" };
      const report = await input.verificationRunner.runToReport(
        { projectId: input.workspaceRoot, kinds: [kind], requestId: request.actionId },
        signal ?? new AbortController().signal,
      );
      verificationSequence += 1;
      publishVerification(input, verificationSequence, report);
      return {
        status: report.overallStatus === "passed" && live(input) ? "completed" : "failed",
      };
    },
  };
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

function live(input: ProductionManagedWorktreeToolInput): boolean {
  try {
    input.liveFacts();
    return Date.now() < Date.parse(input.authorityExpiresAt);
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
