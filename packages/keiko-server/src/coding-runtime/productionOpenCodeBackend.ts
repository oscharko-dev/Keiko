import { randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  validateCodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeEvent,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-sandbox";

import type { OpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import type { DevLanePortableOpenCodeRuntime } from "./devLanePortableCodingRuntime.js";
import {
  createCodingSafeActivityProjection,
  type CodingSafeActivityProjection,
  type CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";
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
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly gatewayReadiness: Pick<
    OpenCodeGatewayReadinessRegistry,
    "waitForObservedRequest" | "clear"
  >;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly safeActivityProjection?: CodingSafeActivityProjection | undefined;
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
  const safeActivityProjection =
    input.safeActivityProjection ??
    createCodingSafeActivityProjection({ diagnostics: input.diagnostics });
  return {
    safeActivityProjection,
    createRun: (run): QualifiedProductionRuntimeRun =>
      createOpenCodeRun(input, run, safeActivityProjection),
  };
}

function createOpenCodeRun(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
  safeActivityProjection: CodingSafeActivityProjection,
): QualifiedProductionRuntimeRun {
  assertOpenCodeRun(run);
  const safeActivity = safeActivityController(
    run.minted.authorityRef.runId,
    safeActivityProjection,
  );
  try {
    const composition = composeOpenCodeRun(input, run, safeActivity);
    const launch = openCodeLaunchMaterial(input, run);
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

function composeOpenCodeRun(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
  safeActivity: NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>,
): ReturnType<typeof createOpenCodeRuntimeComposition> {
  return createOpenCodeRuntimeComposition({
    portable: {
      verification: input.portable.sidecar,
      resourceRoot: input.portable.installRoot,
      target: input.portable.target,
      admission: admissionPolicy(input.portable),
    },
    stateBaseRoot: join(input.runtimeStateRoot, "coding-runtime", "opencode"),
    capabilities: {
      modelGatewayCapability: run.minted.modelGatewayCapability,
      toolFacadeCapability: run.minted.toolFacadeCapability,
    },
    toolFacade: run.toolFacade,
    governedEventSink: idempotentEventSink(
      run.minted.authorityRef.runId,
      run.minted.authorityRef.envelopeDigest,
      input.runtimeEvidence,
    ),
    onQuestionObserved: liveQuestionSignal(
      run.minted.authorityRef.runId,
      run.minted.authorityRef.envelopeDigest,
      input.runtimeEvidence,
      run.onRuntimeEvent,
    ),
    safeActivity,
    gatewayReadiness: input.gatewayReadiness,
    fetch: input.fetch ?? globalThis.fetch,
    supervisor: runtimeSupervisor(input, run.context.workspaceRoot),
    diagnostics: input.diagnostics,
    onRuntimeEvent: run.onRuntimeEvent,
    authorityLifecycle: run.authorityLifecycle,
    codingToolApprovals: run.codingToolApprovals,
  });
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
): NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]> {
  const terminal =
    boundedCorrelations<Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>>();
  const knownCalls = boundedCorrelations<true>();
  let armed = false;
  const ingest = (signal: CodingSafeActivitySignal): boolean => {
    if (!armed) return true;
    const accepted = projection.ingest(runId, signal);
    if (accepted && signal.kind === "tool") {
      rememberKnownCall(runId, signal.callId, projection, knownCalls, terminal);
      schedulePendingTerminal(runId, signal.callId, projection, terminal, knownCalls);
    }
    return accepted;
  };
  return {
    arm: (): void => {
      armed = true;
    },
    clear: (): void => {
      armed = false;
      clearCorrelations(terminal);
      clearCorrelations(knownCalls);
    },
    ingest,
    recordDrops: (count): void => {
      if (armed) projection.recordDrops(runId, "validation-rejected", count);
    },
    settleTool: ({ actionId, state, occurredAt }): void => {
      if (!armed) return;
      const callId = callIdFromAction(actionId);
      if (callId === undefined) {
        projection.recordDrop(runId, "validation-rejected");
        return;
      }
      const signal = { kind: "tool", callId, state, occurredAt } as const;
      rememberTerminal(runId, callId, signal, projection, terminal, knownCalls);
      if (knownCalls.values.has(callId)) {
        schedulePendingTerminal(runId, callId, projection, terminal, knownCalls);
      }
    },
  };
}

function schedulePendingTerminal(
  runId: string,
  callId: string,
  projection: CodingSafeActivityProjection,
  pending: BoundedCorrelations<Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>>,
  known: BoundedCorrelations<true>,
): void {
  queueMicrotask(() => {
    applyPendingTerminal(runId, callId, projection, pending, known);
  });
}

function applyPendingTerminal(
  runId: string,
  callId: string,
  projection: CodingSafeActivityProjection,
  pending: BoundedCorrelations<Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>>,
  known: BoundedCorrelations<true>,
): void {
  const signal = pending.values.get(callId);
  if (signal !== undefined && projection.ingest(runId, signal)) {
    deleteCorrelation(pending, callId);
    deleteCorrelation(known, callId);
  }
}

function rememberKnownCall(
  runId: string,
  callId: string,
  projection: CodingSafeActivityProjection,
  known: BoundedCorrelations<true>,
  pending: BoundedCorrelations<Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>>,
): void {
  const evicted = rememberBoundedCorrelation(known, callId, true);
  for (const identity of evicted) deleteCorrelation(pending, identity);
  projection.recordDrops(runId, "capacity-rejected", evicted.length);
}

function rememberTerminal(
  runId: string,
  callId: string,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
  projection: CodingSafeActivityProjection,
  pending: BoundedCorrelations<Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>>,
  known: BoundedCorrelations<true>,
): void {
  const evicted = rememberBoundedCorrelation(pending, callId, signal);
  for (const identity of evicted) deleteCorrelation(known, identity);
  projection.recordDrops(runId, "capacity-rejected", evicted.length);
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

function openCodeLaunchMaterial(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
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
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 5_000,
    startTimeoutMs: 30_000,
    confinement: input.portable.qualification,
  };
}

/** OpenCode never serves Codex subscription profiles; reject before any process work begins. */
function assertOpenCodeRun(run: ProductionRuntimeBackendInput): void {
  if (
    run.context.runtimeSource !== "keiko-sidecar" ||
    run.context.modelProfile.source !== "keiko-model-gateway"
  ) {
    throw new Error("opencode-backend-profile-mismatch");
  }
}

function runtimeSupervisor(
  input: ProductionOpenCodeBackendInput,
  workspaceRoot: string,
): RuntimeProcessSupervisor {
  if (input.createSupervisor) {
    return input.createSupervisor({ workspaceRoot, portable: input.portable });
  }
  if (isDevLaneRuntime(input.portable)) return devLaneSupervisor(input.portable);
  if (isEvaluationLaneRuntime(input.portable) && input.portable.target !== "windows-x64") {
    return macosEvaluationSupervisor(input.portable);
  }
  return createRuntimeProcessSupervisor({
    backend: createNativeRuntimeProcessBackend({
      helperPath: input.portable.nativeHelperPath,
      runtimeRoots: [join(input.portable.installRoot, input.portable.sidecar.payloadRootPath)],
      workspaceRoot,
      identity: input.portable.qualification,
    }),
    qualifications: [input.portable.qualification],
  });
}

/**
 * macOS evaluation supervision (ADR-0163 D9). The native supervisor connects to the runtime
 * monitor socket served ONLY by the Endpoint Security system extension, which requires an
 * Apple-entitled, notarized, user-approved install; on an unsigned build it fails at first spawn
 * with ERROR_MONITOR_UNAVAILABLE. macOS evaluation therefore uses the same weaker, honestly
 * declared app-sandbox backend the dev lane uses: no descendant containment is proven and process
 * supervision is weaker. Windows evaluation keeps the native Job Object supervisor, which needs no
 * signature and provides real containment.
 */
function macosEvaluationSupervisor(
  portable: QualifiedPortableOpenCodeRuntime,
): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: createDevLaneRuntimeProcessBackend({
      identity: {
        platform: "darwin",
        arch: portable.qualification.arch,
        backend: "macos-app-sandbox",
      },
      runtimeRoot: join(portable.installRoot, portable.sidecar.payloadRootPath),
    }),
    qualifications: [portable.qualification],
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

/**
 * Dev-lane supervision (#2475, ADR-0140): the process backend spawns the verified staged payload
 * directly and terminates its POSIX process group. It carries none of the release-qualified
 * containment or orphan-reaping guarantees; the runtime's evidence class records that posture.
 */
function devLaneSupervisor(portable: DevLanePortableOpenCodeRuntime): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: createDevLaneRuntimeProcessBackend({
      identity: {
        platform: "darwin",
        arch: portable.qualification.arch,
        backend: "macos-app-sandbox",
      },
      runtimeRoot: join(portable.installRoot, portable.sidecar.payloadRootPath),
    }),
    qualifications: [portable.qualification],
  });
}

function idempotentEventSink(
  runId: string,
  authorityDigest: string,
  evidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
): OpenCodeRuntimeCompositionInput["governedEventSink"] {
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
  const identities = new Set<string>();
  let questionSignalSequence = 0;
  return (identity): void => {
    if (identities.has(identity)) return;
    identities.add(identity);
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
