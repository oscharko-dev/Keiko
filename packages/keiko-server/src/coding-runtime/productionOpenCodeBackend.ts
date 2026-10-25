import type { CodingRuntimeHistory } from "./codingRuntimeHistory.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type {
  CodingWorkbenchSidecarGatewayRunMetadata,
  CodingWorkbenchRuntimeEvent,
  UpdatePortableTarget,
  McpServerDefinition,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { isCodingSafeActivityToolPresentation } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-contracts/runtime/runtime-qualification";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createRuntimeGatewayConfinement,
  nativeHomeDeniedReadRoots,
  nativeToolchainReadRoots,
  type LongLivedRuntimeSandboxAttestation,
  type RuntimeGatewayEgress,
  type RuntimeGatewayFilesystem,
} from "@oscharko-dev/keiko-sandbox";

import type { OpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { openCodeNativeEgress } from "./opencodeNativeEgress.js";
import {
  recordNativeGitMetadataResolution,
  resolveNativeGitMetadata,
} from "./opencodeNativeGitMetadata.js";
import {
  devLaneCheckoutRoot,
  npmLanePackageRoot,
  type DevLanePortableOpenCodeRuntime,
} from "./devLanePortableCodingRuntime.js";
import {
  codingSafeActivityTtlMs,
  createCodingSafeActivityProjection,
  type CodingSafeActivityProjection,
  type CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";
import { createCodingRuntimeRepositoryItemsPort } from "./codingRuntimeRepositoryItems.js";
import { createCodingRuntimeRepositoryInstructionsPort } from "./codingRuntimeRepositoryInstructions.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import { createDevLaneRuntimeProcessBackend } from "./devLaneRuntimeProcessBackend.js";
import { createNativeRuntimeProcessBackend } from "./nativeRuntimeProcessBackend.js";
import {
  createOpenCodeRuntimeComposition,
  type OpenCodeRuntimeCompositionInput,
} from "./opencodeRuntimeComposition.js";
import { createOpenCodeRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";
import { createOpenCodeRuntimePermissionPort } from "./productionCodingRuntimePermissionPort.js";
import { createOpenCodeRuntimeTurnPort } from "./productionCodingRuntimePorts.js";
import type {
  ProductionRuntimeBackendInput,
  ProductionRuntimeBackendResolver,
  QualifiedProductionRuntimeRun,
} from "./productionCodingRuntimeResolver.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessSupervisor,
} from "./runtimeProcessSupervisor.js";
import { CodingRuntimeLaunchRejectedError } from "./launchFailure.js";
import { codingRuntimeFactDigest } from "./runtimeAuthorityService.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { CodingSessionContinuity } from "./codingSessionContinuity.js";
import {
  OPENCODE_TOOL_SOURCE_DEFINITIONS,
  openCodeVisibleToolNames,
  type OpenCodeToolProfile,
} from "./opencodeToolSchemas.js";
import {
  openCodeConfigDirectory,
  openCodePlanDirectory,
  resolveOpenCodeContextGeometry,
} from "./opencodeLaunchProfile.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import type { RipgrepRuntimeManifest } from "./ripgrepRuntime.js";
import {
  recordOpenCodeRipgrepResolution,
  resolveOpenCodeRipgrep,
  ripgrepLaunchEnvironment,
  ripgrepMappedInheritedEnvNames,
  ripgrepNativePath,
  type OpenCodeRipgrepLocation,
  type OpenCodeRipgrepResolution,
} from "./opencodeRipgrepLaunch.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";

const OPEN_CODE_START_TIMEOUT_MS = 120_000;

const CODING_RUNTIME_CONTEXT_USAGE_OBSERVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.context-usage.observed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.productionOpenCodeBackend.recordContextTelemetry",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["accepted", "rejected"],
    },
    capacityTokens: { type: "integer", dataClass: "count", required: true },
    usedInputTokens: { type: "integer", dataClass: "count", required: true },
    reservedOutputTokens: { type: "integer", dataClass: "count", required: true },
    sampleDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-context-usage"],
  proofIds: ["coding-runtime.context-usage.observed.emitted-line"],
  releaseImpact: "patch",
});

/**
 * Functional-evidence stand-in for a platform-qualified portable OpenCode runtime. It is reachable
 * only through the explicit `createSupervisor` harness seam and never through production discovery.
 */
export interface FunctionalPortableOpenCodeRuntime {
  readonly evidenceClass: "functional-not-platform-qualified";
  readonly installRoot: string;
  readonly target: UpdatePortableTarget;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly nativeHelperPath: string;
}

export type ResolvedPortableOpenCodeRuntime =
  | QualifiedPortableOpenCodeRuntime
  | FunctionalPortableOpenCodeRuntime
  | DevLanePortableOpenCodeRuntime;

export interface ProductionOpenCodeBackendInput {
  readonly portable: ResolvedPortableOpenCodeRuntime;
  readonly runtimeStateRoot: string;
  readonly gatewayUrl: string;
  readonly resolveGatewayRunMetadata?:
    ((modelId: string) => CodingWorkbenchSidecarGatewayRunMetadata | undefined) | undefined;
  /**
   * ADR-0043 D11-D14 (#3390): the full loopback URL the tool facade rides -- the SAME attested
   * origin as `gatewayUrl`, at `/api/coding-sidecar/tool` -- never a second listener.
   */
  readonly toolFacadeUrl: string;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly gatewayReadiness: Pick<
    OpenCodeGatewayReadinessRegistry,
    "waitForObservedRequest" | "verifyObserved" | "clear" | "toolProfile"
  >;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** The host environment the native profile inherits its allowlisted names from (#3897). */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * The runtime host's secure workspace read port, which the native profile reads the workspace's
   * custom agents, commands and skills through (#3903). Absent, a native run admits none and says so.
   */
  readonly secureWorkspaceTextRead?: SecureWorkspaceTextReadPort | undefined;
  /** The operator's `KEIKO_CODING_REPOSITORY_ITEMS_ENABLED` decision; absent keeps the default, on. */
  readonly repositoryItemsEnabled?: boolean | undefined;
  /** The operator's opt-out of the workspace AGENTS.md (#3900 AC3); absent keeps it on. */
  readonly repositoryInstructionsEnabled?: boolean | undefined;
  /** The operator's MCP server registry for one native run (`mcpServerRegistry.ts`). */
  readonly mcpServers?: ((correlationId: string) => readonly McpServerDefinition[]) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly historyCapture?: CodingRuntimeHistory["captureNative"] | undefined;
  /**
   * The server's native session continuity service (S02/S03, #3904): how a run resumes or forks a
   * task's retained session, and where a run that settled normally leaves its own. Absent keeps every
   * run on a fresh session.
   */
  readonly sessionContinuity?: CodingSessionContinuity | undefined;
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
  /**
   * The configured Authority Envelope duration (ms, #3873). The safe-activity projection this
   * backend creates retains a run's feed for that duration plus its retention margin, so a feed
   * is never evicted before the envelope it shows has expired. Absent keeps the projection's
   * default, which follows the default envelope duration.
   */
  readonly runtimeMaxDurationMs?: number | undefined;
  /**
   * Hermetic test seam: the approval table the launch verifies ripgrep against. Production
   * composition never supplies this, so the pinned upstream digests are always the ones used.
   */
  readonly ripgrepManifest?: Readonly<RipgrepRuntimeManifest> | undefined;
  /** Explicit functional-test seam. Production composition never supplies this. */
  readonly createSupervisor?:
    | ((input: {
        readonly workspaceRoot: string;
        readonly portable: ResolvedPortableOpenCodeRuntime;
      }) => RuntimeProcessSupervisor)
    | undefined;
}

/**
 * Concrete OpenCode process backend for the production coding-runtime resolver. It turns one
 * minted run into a supervised managed OpenCode composition: verified portable artifact, owned
 * process tree, loopback HTTP/SSE client, governed tool bridge, and gateway-bound model routing.
 */
export function createProductionOpenCodeBackend(
  input: ProductionOpenCodeBackendInput,
): ProductionRuntimeBackendResolver {
  const toolProfile = input.gatewayReadiness.toolProfile ?? "direct";
  openCodeVisibleToolNames(toolProfile);
  const safeActivityProjection =
    input.safeActivityProjection ??
    createCodingSafeActivityProjection({
      diagnostics: input.diagnostics,
      activityLog: input.activityLog ?? processServerLogSink(),
      ttlMs:
        input.runtimeMaxDurationMs === undefined
          ? undefined
          : codingSafeActivityTtlMs(input.runtimeMaxDurationMs),
    });
  return Object.freeze({
    toolProfile,
    safeActivityProjection,
    createRun: (run: ProductionRuntimeBackendInput): QualifiedProductionRuntimeRun =>
      createOpenCodeRun(input, run, safeActivityProjection, toolProfile),
  });
}

function createOpenCodeRun(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
  safeActivityProjection: CodingSafeActivityProjection,
  toolProfile: OpenCodeToolProfile,
): QualifiedProductionRuntimeRun {
  assertOpenCodeRun(run);
  const metadata = input.resolveGatewayRunMetadata?.(run.context.modelProfile.profileId);
  const contextGeometry =
    metadata === undefined ? undefined : resolveOpenCodeContextGeometry(metadata);
  if (contextGeometry === undefined) {
    throw new CodingRuntimeLaunchRejectedError("runtime-unqualified");
  }
  const safeActivity = safeActivityController(
    run.minted.authorityRef.runId,
    safeActivityProjection,
    input.historyCapture,
    run.onRuntimeEvent,
  );
  const launchInput = withVerifiedRipgrep(input, run, toolProfile);
  try {
    const composition = composeOpenCodeRun(
      launchInput,
      run,
      safeActivity,
      contextGeometry,
      toolProfile,
    );
    const launch = openCodeLaunchMaterial(launchInput, run, toolProfile);
    const turnPort = createOpenCodeRuntimeTurnPort(composition.runPort);
    const questionPort = createOpenCodeRuntimeQuestionPort(composition.runPort);
    const permissionPort = createOpenCodeRuntimePermissionPort(composition.runPort);
    openSafeActivity(run, safeActivityProjection);
    return {
      manager: composition.manager,
      launch,
      turnPort,
      questionPort,
      permissionPort,
      toolBridge: composition.toolBridge,
      dispose: (): void => {
        safeActivity.clear();
      },
    };
  } catch (error) {
    safeActivity.clear();
    safeActivityProjection.purge(run.minted.authorityRef.runId, "stop");
    throw error;
  }
}

/**
 * What one launch is built from: the backend's input with the environment the child inherits from
 * already carrying the verified ripgrep directory (when there is one), and the resolution that
 * decided it. Every later launch decision reads this one object, so the child PATH, the inherited
 * names and the kernel read allowlist cannot disagree.
 */
type LaunchInput = ProductionOpenCodeBackendInput & {
  readonly ripgrep: OpenCodeRipgrepResolution;
};

function ripgrepLocation(portable: ResolvedPortableOpenCodeRuntime): OpenCodeRipgrepLocation {
  if (isDevLaneRuntime(portable)) {
    const packageRoot = npmLanePackageRoot(portable);
    if (packageRoot !== undefined) return { kind: "npm-package", packageRoot };
    const checkoutRoot = devLaneCheckoutRoot(portable);
    return checkoutRoot === undefined
      ? { kind: "override-only" }
      : { kind: "checkout", checkoutRoot };
  }
  if ("platformAssurance" in portable) {
    return { kind: "packaged", resourceRoot: portable.installRoot, activation: portable.manifest };
  }
  return { kind: "override-only" };
}

/**
 * Resolves the pinned ripgrep once for this launch, records the closed outcome, and returns the
 * input whose inherited environment carries only a VERIFIED directory. An unverified ripgrep
 * changes nothing: the run still starts, search degrades, and the reason is on the Activity Log.
 */
function withVerifiedRipgrep(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): LaunchInput {
  const native = toolProfile === "native";
  const ripgrep = resolveOpenCodeRipgrep({
    target: input.portable.target,
    location: ripgrepLocation(input.portable),
    env: input.processEnv,
    manifest: input.ripgrepManifest,
  });
  recordOpenCodeRipgrepResolution(
    input.activityLog ?? processServerLogSink(),
    run.minted.authorityRef.runId,
    native,
    ripgrep,
  );
  const processEnv = ripgrepLaunchEnvironment(input.processEnv, ripgrep, native);
  return { ...input, ...(processEnv === undefined ? {} : { processEnv }), ripgrep };
}

function compositionPortableInput(
  input: ProductionOpenCodeBackendInput,
): OpenCodeRuntimeCompositionInput["portable"] {
  return {
    verification: input.portable.sidecar,
    resourceRoot: input.portable.installRoot,
    target: input.portable.target,
    admission: admissionPolicy(input.portable),
  };
}

function composeOpenCodeRun(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  safeActivity: NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>,
  contextGeometry: OpenCodeRuntimeCompositionInput["contextGeometry"],
  toolProfile: OpenCodeToolProfile,
): ReturnType<typeof createOpenCodeRuntimeComposition> {
  return createOpenCodeRuntimeComposition({
    toolProfile,
    ...(input.processEnv === undefined ? {} : { processEnv: input.processEnv }),
    ...nativeRunInputs(input, run, toolProfile),
    portable: compositionPortableInput(input),
    stateBaseRoot: openCodeStateBaseRoot(input.runtimeStateRoot),
    contextGeometry,
    capabilities: {
      modelGatewayCapability: run.minted.modelGatewayCapability,
      toolFacadeCapability: run.minted.toolFacadeCapability,
    },
    toolFacadeOrigin: input.toolFacadeUrl,
    toolFacade: run.toolFacade,
    governedEventSink: idempotentEventSink(
      run.minted.authorityRef.runId,
      run.minted.authorityRef.envelopeDigest,
      input.runtimeEvidence,
      run,
      contextGeometry,
      input.activityLog ?? processServerLogSink(),
    ),
    onQuestionObserved: liveQuestionSignal(
      run.minted.authorityRef.runId,
      run.minted.authorityRef.envelopeDigest,
      input.runtimeEvidence,
      run.onRuntimeEvent,
    ),
    safeActivity,
    ...sessionContinuityFor(input, run),
    gatewayReadiness: input.gatewayReadiness,
    fetch: input.fetch ?? globalThis.fetch,
    supervisor: runtimeSupervisor(input, run, toolProfile),
    diagnostics: input.diagnostics,
    activityLog: input.activityLog,
    toolResultCorrelationId: run.minted.authorityRef.runId,
    onRuntimeEvent: run.onRuntimeEvent,
    onSandboxAttestation: observeOpenCodeSandboxAttestation(input, run),
    ...runtimeLaunchSafety(run),
    // #3873: one submitted task's whole agent loop is bounded by the run's own envelope duration,
    // never by a fixed turn wall shorter than the envelope the operator configured.
    maxTurnWaitMs: run.context.budget.maxRuntimeMs,
  });
}

/**
 * The directories of the admitted local MCP servers' executables join the toolchain `PATH` the
 * kernel reads from (#3903): an MCP server is a process of the run, and it runs only where its
 * install prefix is readable, under the same rules as every toolchain (a home directory or anything
 * above it is never opened).
 */
function withMcpExecutableDirectories(
  path: string | undefined,
  servers: readonly McpServerDefinition[],
): string | undefined {
  const directories = servers.flatMap((server) =>
    server.enabled && server.transport.kind === "local"
      ? [dirname(server.transport.command[0])]
      : [],
  );
  if (directories.length === 0) return path;
  return [...(path === undefined ? [] : [path]), ...directories].join(delimiter);
}

// What only a native run reads from the repository and the operator: its Markdown items (#3903)
// and its MCP servers (C04).
function nativeRunInputs(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): Pick<
  OpenCodeRuntimeCompositionInput,
  "repositoryItems" | "repositoryInstructions" | "mcpServers"
> {
  if (toolProfile !== "native") return {};
  return {
    repositoryItems: repositoryItemsFor(input, run),
    repositoryInstructions: repositoryInstructionsFor(input, run),
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
  };
}

// A task's retained native session (#3904), bound to the run's own workspace.
function sessionContinuityFor(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
): Pick<OpenCodeRuntimeCompositionInput, "sessionContinuity"> {
  return input.sessionContinuity === undefined
    ? {}
    : {
        sessionContinuity: {
          service: input.sessionContinuity,
          workspaceId: run.context.workspaceId,
        },
      };
}

// The run's AGENTS.md as the native runtime's own instruction source (#3900 AC3), read only while
// its workspace is still the active one.
function repositoryInstructionsFor(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
): NonNullable<OpenCodeRuntimeCompositionInput["repositoryInstructions"]> {
  const port = createCodingRuntimeRepositoryInstructionsPort({
    enabled: input.repositoryInstructionsEnabled !== false,
    delivery: "native-instructions",
    source: input.secureWorkspaceTextRead,
    activityLog: input.activityLog ?? processServerLogSink(),
  });
  return {
    materializeForRun: (request) =>
      port.materializeForRun({ ...request, isRunWorkspace: run.workspaceIsCurrent }),
  };
}

// The run's own repository items (#3903), read only while its workspace is still the active one.
function repositoryItemsFor(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
): ReturnType<typeof createCodingRuntimeRepositoryItemsPort> {
  return createCodingRuntimeRepositoryItemsPort({
    enabled: input.repositoryItemsEnabled !== false,
    source: input.secureWorkspaceTextRead,
    isRunWorkspace: run.workspaceIsCurrent,
    activityLog: input.activityLog ?? processServerLogSink(),
  });
}

function openCodeStateBaseRoot(runtimeStateRoot: string): string {
  mkdirSync(runtimeStateRoot, { recursive: true, mode: 0o700 });
  return join(realpathSync(runtimeStateRoot), "coding-runtime", "opencode");
}

function runtimeLaunchSafety(
  run: ProductionRuntimeBackendInput,
): Pick<
  OpenCodeRuntimeCompositionInput,
  "resolveWorkspaceRootAccess" | "canSpawnRuntime" | "authorityLifecycle" | "codingToolApprovals"
> {
  return {
    authorityLifecycle: run.authorityLifecycle,
    codingToolApprovals: run.codingToolApprovals,
    resolveWorkspaceRootAccess: run.resolveWorkspaceRootAccess,
    canSpawnRuntime: run.canSpawnRuntime,
  };
}

function observeOpenCodeSandboxAttestation(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
): (runId: string, attestation: LongLivedRuntimeSandboxAttestation) => void {
  return (runId, attestation): void => {
    if (runId !== run.minted.authorityRef.runId) {
      throw new Error("sandbox-attestation-run-mismatch");
    }
    input.runtimeEvidence.observe(runId, {
      kind: "sandbox-attestation",
      state: "starting",
      authorityDigest: run.minted.authorityRef.envelopeDigest,
      sandboxAttestation: attestation,
    });
  };
}

const MAX_SAFE_ACTIVITY_TOOL_CORRELATIONS = 2_048;
const MAX_SAFE_ACTIVITY_TOOL_CORRELATION_BYTES = 128 * 1_024;
const SAFE_ACTIVITY_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface BoundedCorrelations<T> {
  readonly values: Map<string, T>;
  bytes: number;
}

function openSafeActivity(
  run: ProductionRuntimeBackendInput,
  projection: CodingSafeActivityProjection,
): void {
  projection.open({
    runId: run.minted.authorityRef.runId,
    workspaceId: run.context.workspaceId,
    authorityExpiresAt: run.context.expiresAt,
    workspaceIsCurrent: run.workspaceIsCurrent,
  });
}

function safeActivityController(
  runId: string,
  projection: CodingSafeActivityProjection,
  historyCapture: ProductionOpenCodeBackendInput["historyCapture"],
  onRuntimeEvent: ProductionRuntimeBackendInput["onRuntimeEvent"],
): NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]> {
  const tools: ActivityToolCorrelations = {
    runId,
    projection,
    terminal: boundedCorrelations<ToolSignal>(),
    knownCalls: boundedCorrelations<KnownActivityTool>(),
    binding: undefined,
    armed: false,
  };
  const retryObserver = nativeRetryObserver(runId, onRuntimeEvent);
  return {
    captureMessages: (messages): boolean =>
      tools.armed && historyCapture?.(runId, messages) === true,
    arm: (sessionId, profile): void => {
      bindActivityTools(tools, sessionId, profile);
      tools.armed = true;
    },
    beginTool: (input): void => {
      if (tools.armed) rememberAdmittedChild(tools, input);
    },
    clear: (): void => {
      tools.armed = false;
      tools.binding = undefined;
      retryObserver.clear();
      clearCorrelations(tools.terminal);
      clearCorrelations(tools.knownCalls);
    },
    ingest: (signal): boolean => ingestActivitySignal(tools, retryObserver, signal),
    recordDrops: (count): void => {
      if (tools.armed) projection.recordDrops(runId, "validation-rejected", count);
    },
    settleTool: (input): void => {
      if (tools.armed) rememberSettledTool(tools, input);
    },
  };
}

function ingestActivitySignal(
  tools: ActivityToolCorrelations,
  retryObserver: ReturnType<typeof nativeRetryObserver>,
  signal: CodingSafeActivitySignal,
): boolean {
  if (!tools.armed) return true;
  const accepted = tools.projection.ingest(tools.runId, signal);
  if (accepted) retryObserver.observe(signal);
  if (accepted && signal.kind === "tool") {
    rememberObservedCall(tools, signal);
    schedulePendingTerminal(tools, signal.callId);
    scheduleParentChildren(tools, signal.callId);
  }
  return accepted;
}

function bindActivityTools(
  tools: ActivityToolCorrelations,
  sessionId: string | undefined,
  profile: OpenCodeToolProfile | undefined,
): void {
  const binding =
    profile === "code-mode" &&
    sessionId !== undefined &&
    /^ses_[A-Za-z0-9_-]{1,251}$/u.test(sessionId)
      ? { sessionId, profile }
      : undefined;
  if (tools.binding?.sessionId !== binding?.sessionId) {
    clearCorrelations(tools.terminal);
    clearCorrelations(tools.knownCalls);
  }
  tools.binding = binding;
}

type ToolSignal = Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>;
type KnownActivityTool =
  | {
      readonly kind: "native";
      readonly messageId?: string;
      readonly parentHash?: string;
      readonly invalid?: true;
    }
  | { readonly kind: "child"; readonly parentHash: string; readonly tool: string };
interface ActivityToolCorrelations {
  readonly runId: string;
  readonly projection: CodingSafeActivityProjection;
  readonly terminal: BoundedCorrelations<ToolSignal>;
  readonly knownCalls: BoundedCorrelations<KnownActivityTool>;
  armed: boolean;
  binding: { readonly sessionId: string; readonly profile: OpenCodeToolProfile } | undefined;
}
const MAPPED_ACTIVITY_TOOLS: ReadonlySet<string> = new Set(
  OPENCODE_TOOL_SOURCE_DEFINITIONS.map(({ name }) => name),
);

function capturedChildHash(tools: ActivityToolCorrelations, actionId: string): string | undefined {
  const binding = tools.binding;
  if (binding === undefined || !actionId.startsWith(`${binding.sessionId}:`)) return undefined;
  const match = /^cm_([a-f0-9]{64})_([1-9]\d{0,3})$/u.exec(callIdFromAction(actionId) ?? "");
  return match !== null && Number(match[2]) <= MAX_SAFE_ACTIVITY_TOOL_CORRELATIONS
    ? match[1]
    : undefined;
}

function rememberAdmittedChild(
  tools: ActivityToolCorrelations,
  input: Parameters<
    NonNullable<NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>["beginTool"]>
  >[0],
): void {
  if (tools.binding === undefined || !callIdFromAction(input.actionId)?.startsWith("cm_")) return;
  const parentHash = capturedChildHash(tools, input.actionId);
  const callId = callIdFromAction(input.actionId);
  if (parentHash === undefined || callId === undefined || !MAPPED_ACTIVITY_TOOLS.has(input.tool)) {
    tools.projection.recordDrop(tools.runId, "validation-rejected");
    return;
  }
  if (tools.knownCalls.values.has(callId)) return;
  rememberKnownCall(tools, callId, { kind: "child", parentHash, tool: input.tool });
  rememberTerminal(tools, callId, {
    kind: "tool",
    callId,
    tool: input.tool,
    state: "running",
    occurredAt: input.occurredAt,
  });
  schedulePendingTerminal(tools, callId);
}

function rememberSettledTool(
  tools: ActivityToolCorrelations,
  input: Parameters<NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>["settleTool"]>[0],
): void {
  const signal = settledToolSignal(input);
  if (signal === undefined) {
    tools.projection.recordDrop(tools.runId, "validation-rejected");
    return;
  }
  if (tools.binding !== undefined && signal.callId.startsWith("cm_")) {
    // A refusal or replay answered without executing is not another admitted child operation.
    if (input.delegateStarted !== true) return;
    if (
      capturedChildHash(tools, input.actionId) === undefined ||
      tools.knownCalls.values.get(signal.callId)?.kind !== "child"
    ) {
      tools.projection.recordDrop(tools.runId, "validation-rejected");
      return;
    }
  }
  rememberTerminal(tools, signal.callId, signal);
  if (tools.knownCalls.values.has(signal.callId)) schedulePendingTerminal(tools, signal.callId);
}

function nativeParentHash(tools: ActivityToolCorrelations, signal: ToolSignal): string | undefined {
  const binding = tools.binding;
  if (binding === undefined || signal.tool !== "execute" || signal.messageId === undefined)
    return undefined;
  return createHash("sha256").update(`${binding.sessionId}:${signal.callId}`).digest("hex");
}

function ambiguousParent(
  existing: Extract<KnownActivityTool, { readonly kind: "native" }> | undefined,
  signal: ToolSignal,
): boolean {
  return (
    existing?.invalid === true ||
    (existing?.parentHash !== undefined &&
      (existing.messageId !== signal.messageId || signal.tool !== "execute"))
  );
}

function rememberObservedCall(tools: ActivityToolCorrelations, signal: ToolSignal): void {
  const existing = tools.knownCalls.values.get(signal.callId);
  if (existing?.kind === "child") return;
  if (ambiguousParent(existing, signal)) {
    if (existing !== undefined)
      rememberKnownCall(tools, signal.callId, { ...existing, invalid: true });
    tools.projection.recordDrop(tools.runId, "validation-rejected");
    return;
  }
  const parentHash = nativeParentHash(tools, signal);
  rememberKnownCall(tools, signal.callId, {
    kind: "native",
    ...(signal.messageId === undefined ? {} : { messageId: signal.messageId }),
    ...(parentHash === undefined ? {} : { parentHash }),
  });
}

function scheduleParentChildren(tools: ActivityToolCorrelations, callId: string): void {
  const parent = tools.knownCalls.values.get(callId);
  if (parent?.kind !== "native" || parent.parentHash === undefined || parent.invalid === true)
    return;
  for (const [childId, child] of tools.knownCalls.values) {
    if (child.kind === "child" && child.parentHash === parent.parentHash)
      schedulePendingTerminal(tools, childId);
  }
}

function nativeRetryObserver(
  runId: string,
  onRuntimeEvent: ProductionRuntimeBackendInput["onRuntimeEvent"],
): {
  readonly observe: (signal: CodingSafeActivitySignal) => void;
  readonly clear: () => void;
} {
  let current: { readonly messageId: string; readonly digest: string } | undefined;
  let sequence = 0;
  const observe = (signal: CodingSafeActivitySignal): void => {
    if (signal.kind !== "message" || signal.role !== "assistant") return;
    const nativeRetry = ownNativeRetryFact(signal.nativeRetry);
    if (nativeRetry === null && current?.messageId !== signal.messageId) return;
    const factDigest = codingRuntimeFactDigest([signal.messageId, nativeRetry]);
    if (factDigest === current?.digest) return;
    current =
      nativeRetry === null ? undefined : { messageId: signal.messageId, digest: factDigest };
    onRuntimeEvent({
      schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
      eventId: `event-runtime-status-${String(++sequence)}`,
      runId,
      occurredAt: new Date().toISOString(),
      kind: "native-retry-changed",
      nativeRetry,
    });
  };
  return {
    observe,
    clear: (): void => {
      current = undefined;
    },
  };
}

function ownNativeRetryFact(
  fact: CodingWorkbenchRuntimeEvent["nativeRetry"],
): NonNullable<CodingWorkbenchRuntimeEvent["nativeRetry"]> | null {
  return fact === undefined || fact === null ? null : Object.freeze({ ...fact });
}

function settledToolSignal({
  actionId,
  state,
  occurredAt,
  presentation,
}: Parameters<NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>["settleTool"]>[0]):
  Extract<CodingSafeActivitySignal, { readonly kind: "tool" }> | undefined {
  const callId = callIdFromAction(actionId);
  if (
    callId === undefined ||
    (presentation !== undefined && !isCodingSafeActivityToolPresentation(presentation))
  )
    return undefined;
  return {
    kind: "tool",
    callId,
    state,
    occurredAt,
    ...(presentation === undefined ? {} : { presentation: Object.freeze({ ...presentation }) }),
  };
}

function schedulePendingTerminal(tools: ActivityToolCorrelations, callId: string): void {
  queueMicrotask(() => {
    applyPendingTerminal(tools, callId);
  });
}

function joinedChildSignal(
  tools: ActivityToolCorrelations,
  signal: ToolSignal,
): ToolSignal | undefined {
  const child = tools.knownCalls.values.get(signal.callId);
  if (child?.kind !== "child") return signal;
  for (const parent of tools.knownCalls.values.values()) {
    if (
      parent.kind === "native" &&
      parent.parentHash === child.parentHash &&
      parent.messageId !== undefined &&
      parent.invalid !== true
    ) {
      return { ...signal, messageId: parent.messageId, tool: child.tool };
    }
  }
  return undefined;
}

function applyPendingTerminal(tools: ActivityToolCorrelations, callId: string): void {
  const pending = tools.terminal.values.get(callId);
  const signal = pending === undefined ? undefined : joinedChildSignal(tools, pending);
  if (signal !== undefined && tools.projection.ingest(tools.runId, signal)) {
    deleteCorrelation(tools.terminal, callId);
    if (signal.state !== "running") deleteCorrelation(tools.knownCalls, callId);
  }
}

function rememberKnownCall(
  tools: ActivityToolCorrelations,
  callId: string,
  value: KnownActivityTool,
): void {
  const evicted = rememberBoundedCorrelation(tools.knownCalls, callId, value);
  for (const identity of evicted) deleteCorrelation(tools.terminal, identity);
  tools.projection.recordDrops(tools.runId, "capacity-rejected", evicted.length);
}

function rememberTerminal(
  tools: ActivityToolCorrelations,
  callId: string,
  signal: ToolSignal,
): void {
  const evicted = rememberBoundedCorrelation(tools.terminal, callId, signal);
  for (const identity of evicted) deleteCorrelation(tools.knownCalls, identity);
  tools.projection.recordDrops(tools.runId, "capacity-rejected", evicted.length);
}

function rememberBoundedCorrelation<T>(
  correlations: BoundedCorrelations<T>,
  callId: string,
  value: T,
): readonly string[] {
  deleteCorrelation(correlations, callId);
  correlations.values.set(callId, value);
  correlations.bytes += correlationBytes(callId, value);
  const evicted: string[] = [];
  while (
    correlations.values.size > MAX_SAFE_ACTIVITY_TOOL_CORRELATIONS ||
    correlations.bytes > MAX_SAFE_ACTIVITY_TOOL_CORRELATION_BYTES
  ) {
    const oldest = correlations.values.keys().next().value;
    if (oldest === undefined) break;
    evicted.push(oldest);
    deleteCorrelation(correlations, oldest);
  }
  return evicted;
}

function boundedCorrelations<T>(): BoundedCorrelations<T> {
  return { values: new Map(), bytes: 0 };
}

function clearCorrelations<T>(correlations: BoundedCorrelations<T>): void {
  correlations.values.clear();
  correlations.bytes = 0;
}

function deleteCorrelation<T>(correlations: BoundedCorrelations<T>, callId: string): void {
  const value = correlations.values.get(callId);
  if (value === undefined) return;
  correlations.values.delete(callId);
  correlations.bytes = Math.max(0, correlations.bytes - correlationBytes(callId, value));
}

function correlationBytes(callId: string, value: unknown): number {
  return Buffer.byteLength(callId, "utf8") + Buffer.byteLength(JSON.stringify(value), "utf8");
}

function callIdFromAction(actionId: string): string | undefined {
  const separator = actionId.indexOf(":");
  const callId = separator >= 0 ? actionId.slice(separator + 1) : "";
  return SAFE_ACTIVITY_CALL_ID.test(callId) ? callId : undefined;
}

/**
 * The environment names the native profile (#3897) inherits from the launcher: the toolchain
 * search path and locale facts a standalone shell would see. Never a credential name
 * (`buildRuntimeEnv` refuses those), and the mapped profiles inherit nothing.
 */
const NATIVE_INHERITED_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
]);

function openCodeLaunchMaterial(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): QualifiedProductionRuntimeRun["launch"] {
  return {
    recoveryHandle: randomBytes(16).toString("hex"),
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    executablePath: join(input.portable.installRoot, input.portable.sidecar.executablePath),
    managedRoot: join(input.portable.installRoot, input.portable.sidecar.payloadRootPath),
    gatewayUrl: input.gatewayUrl,
    modelProfileId: run.context.modelProfile.profileId,
    args: [],
    inheritedEnvAllowlist:
      toolProfile === "native"
        ? NATIVE_INHERITED_ENV_ALLOWLIST
        : ripgrepMappedInheritedEnvNames(input.ripgrep),
    shutdownTimeoutMs: 5_000,
    startTimeoutMs: OPEN_CODE_START_TIMEOUT_MS,
    confinement: input.portable.qualification,
  };
}

/** OpenCode never serves Codex subscription profiles; reject before any process work begins. */
function assertOpenCodeRun(run: ProductionRuntimeBackendInput): void {
  if (
    run.context.runtimeSource !== "keiko-sidecar" ||
    run.context.modelProfile.source !== "keiko-model-gateway"
  ) {
    // Structured, not a bare Error: this is exactly the manager's `adapter-profile-mismatch`, and
    // throwing it typed lets the orchestrator report the real cause instead of collapsing every
    // launch rejection into one generic code (KEIKO-0150).
    throw new CodingRuntimeLaunchRejectedError("adapter-profile-mismatch");
  }
}

function runtimeSupervisor(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): RuntimeProcessSupervisor {
  const workspaceRoot = run.context.workspaceRoot;
  if (input.createSupervisor) {
    return input.createSupervisor({ workspaceRoot, portable: input.portable });
  }
  if (isDevLaneRuntime(input.portable)) {
    return devLaneSupervisor(input.portable, input, run, toolProfile);
  }
  if (input.portable.target === "linux-x64") {
    return linuxNamespaceGatewaySupervisor(input.portable, input, run, toolProfile);
  }
  if (isEvaluationLaneRuntime(input.portable) && input.portable.target !== "windows-x64") {
    return appSandboxSupervisor(input.portable, input, run, toolProfile);
  }
  return createRuntimeProcessSupervisor({
    backend: createNativeRuntimeProcessBackend({
      helperPath: input.portable.nativeHelperPath,
      runtimeRoots: [join(input.portable.installRoot, input.portable.sidecar.payloadRootPath)],
      workspaceRoot,
      identity: input.portable.qualification,
      gatewayConfinement: runtimeGatewayConfinement(input.portable, input, run, toolProfile),
    }),
    qualifications: [input.portable.qualification],
  });
}

function linuxNamespaceGatewaySupervisor(
  portable: ResolvedPortableOpenCodeRuntime,
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: createDevLaneRuntimeProcessBackend({
      identity: {
        platform: "linux",
        arch: "x64",
        backend: "linux-namespace-gateway",
      },
      runtimeRoot: join(portable.installRoot, portable.sidecar.payloadRootPath),
      gatewayConfinement: runtimeGatewayConfinement(portable, input, run, toolProfile),
    }),
    qualifications: [portable.qualification],
  });
}

function devLaneSupervisor(
  portable: DevLanePortableOpenCodeRuntime,
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): RuntimeProcessSupervisor {
  if (portable.target !== "windows-x64")
    return appSandboxSupervisor(portable, input, run, toolProfile);
  if (portable.nativeHelperPath === undefined) throw new Error("dev-lane-supervisor-missing");
  return createRuntimeProcessSupervisor({
    backend: createNativeRuntimeProcessBackend({
      helperPath: portable.nativeHelperPath,
      expectedHelperSha256: portable.nativeHelperSha256,
      runtimeRoots: [join(portable.installRoot, portable.sidecar.payloadRootPath)],
      workspaceRoot: run.context.workspaceRoot,
      identity: portable.qualification,
      gatewayConfinement: runtimeGatewayConfinement(portable, input, run, toolProfile),
    }),
    qualifications: [portable.qualification],
  });
}

/**
 * The macOS dev/evaluation supervisor enforces the exact gateway TCP endpoint across descendants
 * and denies service-based escape. Its evidence class still carries no release signature or platform
 * qualification. Windows dev-lane runs use the native Job Object supervisor.
 *
 * Dev lane (#2475, ADR-0140): no packaged install exists to supervise natively.
 * Evaluation lane (ADR-0163 D9): the native supervisor connects to the runtime monitor socket served
 * ONLY by the Endpoint Security system extension, which requires an Apple-entitled, notarized,
 * user-approved install; on an unsigned build it fails at first spawn with
 * ERROR_MONITOR_UNAVAILABLE. Windows evaluation is unaffected — its Job Object supervisor needs no
 * signature and its containment is real.
 *
 * One body for both, because two byte-identical copies would let a future edit weaken one lane's
 * supervision while the other silently kept the old shape.
 */
function appSandboxSupervisor(
  portable: QualifiedPortableOpenCodeRuntime | DevLanePortableOpenCodeRuntime,
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: createDevLaneRuntimeProcessBackend({
      identity: {
        platform: "darwin",
        arch: portable.qualification.arch,
        backend: "macos-app-sandbox",
      },
      runtimeRoot: join(portable.installRoot, portable.sidecar.payloadRootPath),
      gatewayConfinement: runtimeGatewayConfinement(portable, input, run, toolProfile),
    }),
    qualifications: [portable.qualification],
  });
}

/**
 * Credential stores the native agent must never read, whatever it runs (ADR-0129 D3 hard denial):
 * the well-known secret locations and the user's other agent state under the home
 * (`nativeHomeDeniedReadRoots`, the same list that keeps a toolchain root from reopening them),
 * plus Keiko's own state directory (gateway credentials, vault, the Activity Log).
 */
function nativeDeniedReadRoots(runtimeStateRoot: string): readonly string[] {
  return [...nativeHomeDeniedReadRoots(homedir()), realpathSync(runtimeStateRoot)];
}

/**
 * The native profile's kernel network disposition follows the run's launch mode (#3897,
 * `openCodeNativeEgress`): only Full access keeps inherited egress, bounded by its Authority
 * Envelope and the per-action policy; Ask for approval and Supervised workspace reach loopback only
 * (the attested Model Gateway, the tool facade, local dev servers). The mapped profile has no
 * network of its own. The composition refuses an in-place narrowing that this binding could not honor.
 */
function nativeEgress(mode: string): RuntimeGatewayEgress {
  return openCodeNativeEgress(mode);
}

function gatewayFilesystem(
  portable: ResolvedPortableOpenCodeRuntime,
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  native: boolean,
): { readonly filesystem?: RuntimeGatewayFilesystem } {
  const macos = portable.target === "macos-arm64" || portable.target === "macos-x64";
  // Linux confines only the native profile, with a bubblewrap mount allowlist; the gateway profile
  // keeps its namespace bridge launcher there.
  if (!macos && !(native && portable.target === "linux-x64")) return {};
  const privateStateRoot = join(
    realpathSync(input.runtimeStateRoot),
    "coding-runtime",
    "opencode",
    run.minted.authorityRef.runId,
  );
  return {
    filesystem: {
      workspaceRoot: run.context.workspaceRoot,
      workspaceAccess: native ? "read-write" : "read-only",
      privateStateRoot,
      runtimeReadRoot: realpathSync(join(portable.installRoot, portable.sidecar.payloadRootPath)),
      ...(native
        ? {
            deniedReadRoots: nativeDeniedReadRoots(input.runtimeStateRoot),
            // The launcher's PATH plus the one verified ripgrep directory the child gets in front
            // of it, so the kernel opens exactly what the child can run and nothing broader.
            toolchainReadRoots: nativeToolchainReadRoots(
              withMcpExecutableDirectories(
                ripgrepNativePath(process.env.PATH, input.ripgrep) ?? process.env.PATH,
                input.mcpServers?.(run.minted.authorityRef.runId) ?? [],
              ),
              homedir(),
            ),
            ...nativeGitMetadataReadRoots(input, run),
            // The policy plugin and the private configuration are read-only to the shell.
            protectedWriteRoots: [openCodeConfigDirectory(privateStateRoot)],
            // The plan agent's private notes take no link that could name a workspace file.
            linkFreeWriteRoots: [openCodePlanDirectory(privateStateRoot)],
          }
        : {}),
    },
  };
}

/** A linked worktree's proven common Git directory, recorded body-free (#3897 review). */
function nativeGitMetadataReadRoots(
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
): { readonly gitMetadataReadRoots?: readonly string[] } {
  const resolution = resolveNativeGitMetadata(
    run.context.workspaceRoot,
    run.resolveWorkspaceRootAccess(),
  );
  recordNativeGitMetadataResolution(
    input.activityLog ?? processServerLogSink(),
    run.minted.authorityRef.runId,
    resolution,
  );
  return resolution.readRoots.length === 0 ? {} : { gitMetadataReadRoots: resolution.readRoots };
}

function runtimeGatewayConfinement(
  portable: ResolvedPortableOpenCodeRuntime,
  input: LaunchInput,
  run: ProductionRuntimeBackendInput,
  toolProfile: OpenCodeToolProfile,
): ReturnType<typeof createRuntimeGatewayConfinement> {
  const native = toolProfile === "native";
  return createRuntimeGatewayConfinement({
    gatewayUrl: input.gatewayUrl,
    runId: run.minted.authorityRef.runId,
    treeBindingId: run.minted.treeBindingId,
    envelopeDigest: run.minted.authorityRef.envelopeDigest,
    runtimeArtifactDigest: portable.sidecar.shippedExecutableSha256,
    modelProfileDigest: codingRuntimeFactDigest(run.context.modelProfile),
    profile: native ? "keiko-native" : "keiko-gateway",
    ...(native ? { egress: nativeEgress(run.minted.effectiveMode) } : {}),
    ...gatewayFilesystem(portable, input, run, native),
  });
}

/** Only the dev-lane union member carries the structural `lane` marker. */
function isDevLaneRuntime(
  portable: ResolvedPortableOpenCodeRuntime,
): portable is DevLanePortableOpenCodeRuntime {
  return "lane" in portable;
}

/** Only the packaged union member carries `platformAssurance` (ADR-0163 D9). */
function isEvaluationLaneRuntime(
  portable: ResolvedPortableOpenCodeRuntime,
): portable is QualifiedPortableOpenCodeRuntime {
  return "platformAssurance" in portable && portable.platformAssurance === "evaluation-unqualified";
}

/**
 * The single producer of the admission marker the launch-time availability re-check reads. An
 * evaluation runtime marked `release-qualified` here would be demanded to prove the full packaged
 * evidence set at start and refused.
 */
function admissionPolicy(
  portable: ResolvedPortableOpenCodeRuntime,
): NonNullable<OpenCodeRuntimeCompositionInput["portable"]["admission"]> {
  if (isDevLaneRuntime(portable)) return "functional-dev-lane";
  return isEvaluationLaneRuntime(portable) ? "functional-evaluation-lane" : "release-qualified";
}

function idempotentEventSink(
  runId: string,
  authorityDigest: string,
  evidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
  run: ProductionRuntimeBackendInput,
  contextGeometry: OpenCodeRuntimeCompositionInput["contextGeometry"],
  activityLog: ServerLogSink,
): OpenCodeRuntimeCompositionInput["governedEventSink"] {
  // KEIKO-0707: use the same bounded-correlation primitive the governed-tool call path uses so
  // idempotency identity retention is capped at MAX_SAFE_ACTIVITY_TOOL_CORRELATIONS instead of
  // growing without bound for the lifetime of the run. Repeated identities within the retained
  // window still short-circuit as duplicate; only identities older than the window may be seen
  // as "applied" a second time -- an acceptable trade for a bounded memory footprint.
  const identities = boundedCorrelations<true>();
  return {
    execute: (identity, event): Promise<"duplicate" | "applied"> => {
      const duplicate = identities.values.has(identity);
      rememberBoundedCorrelation(identities, identity, true);
      if (!duplicate) {
        evidence.observe(runId, {
          kind: event.kind === "tool" ? "tool-call" : "model-request",
          state: "running",
          authorityDigest,
        });
        recordContextTelemetry(run, event, contextGeometry, activityLog);
      }
      return Promise.resolve(duplicate ? "duplicate" : "applied");
    },
  };
}

type ContextUsageActivityMeta =
  | { readonly level: "info"; readonly correlationId: string }
  | {
      readonly level: "warn";
      readonly correlationId: string;
      readonly errorKind: "conflict";
    };

function contextUsageActivityMeta(
  accepted: boolean,
  correlationId: string,
): ContextUsageActivityMeta {
  if (accepted) return { level: "info", correlationId };
  return { level: "warn", correlationId, errorKind: "conflict" };
}

export function recordContextTelemetry(
  run: ProductionRuntimeBackendInput,
  event: OpenCodeReconciliationEvent,
  contextGeometry: OpenCodeRuntimeCompositionInput["contextGeometry"],
  activityLog: ServerLogSink,
): void {
  const registry = run.contextUsage;
  if (registry === undefined) return;
  const providerTokenUsage = event.providerTokenUsage;
  const completedCompaction =
    event.compaction?.event === "completed" ? event.compaction : undefined;
  if (providerTokenUsage === undefined && completedCompaction === undefined) return;
  const updatedAt = new Date().toISOString();
  if (providerTokenUsage !== undefined) {
    const accepted = registry.recordProviderSample(run.request.runId, {
      sampleId: event.digest,
      capacityTokens: contextGeometry.contextWindowTokens,
      reservedOutputTokens: contextGeometry.maxOutputTokens,
      inputTokens: providerTokenUsage.inputTokens,
      updatedAt,
    });
    activityLog.write(
      activityLogEvent(
        CODING_RUNTIME_CONTEXT_USAGE_OBSERVED_OPERATION,
        contextUsageActivityMeta(accepted, run.request.runId),
        {
          state: accepted ? "accepted" : "rejected",
          capacityTokens: contextGeometry.contextWindowTokens,
          usedInputTokens: providerTokenUsage.inputTokens,
          reservedOutputTokens: contextGeometry.maxOutputTokens,
          sampleDigest: event.digest,
        },
      ),
    );
  }
  if (completedCompaction !== undefined) {
    registry.recordCompaction(run.request.runId, completedCompaction.compactionIdSha256, updatedAt);
  }
}

/**
 * A question raised (or settled) inside the managed child is invisible to pull-based clients
 * until they re-list. OpenCode publishes its question lifecycle live-only — never as durable
 * history rows — so the content-free re-list signal originates from the composition's live
 * observation, idempotent per observed frame identity (#2386).
 */
function liveQuestionSignal(
  runId: string,
  authorityDigest: string,
  evidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): (identity: string) => void {
  // KEIKO-0707: bounded identity retention, same reasoning as idempotentEventSink above.
  const identities = boundedCorrelations<true>();
  let questionSignalSequence = 0;
  return (identity): void => {
    if (identities.values.has(identity)) return;
    rememberBoundedCorrelation(identities, identity, true);
    evidence.observe(runId, {
      kind: "model-request",
      state: "running",
      authorityDigest,
    });
    emitQuestionSignal(runId, ++questionSignalSequence, onRuntimeEvent);
  };
}

function emitQuestionSignal(
  runId: string,
  sequence: number,
  onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  const signal: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: `event-question-${String(sequence)}`,
    runId,
    occurredAt: new Date().toISOString(),
    kind: "observation-streamed",
    channel: "question",
    sequence,
    byteCount: 0,
    truncated: false,
  };
  if (validateCodingWorkbenchRuntimeEvent(signal).ok) onRuntimeEvent(signal);
}
