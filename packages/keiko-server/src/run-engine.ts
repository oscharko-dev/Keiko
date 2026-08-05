// The run engine (ADR-0011 D7/D8): it starts a dry-run-first run in the BACKGROUND and bridges it to
// the registry + streaming sink. It maps a validated RunRequest to the existing workflow / harness
// entry points UNCHANGED — generateUnitTests / investigateBug / createSession — and never calls a
// model directly or reimplements a guard. The BFF owns the runId (injected via the workflow idSource
// / read from the harness session) and a fingerprint so the 202 response is synchronous; completion
// is captured into the registry asynchronously. `apply` defaults false; the only place apply becomes
// true is the gated apply path (run-handlers), which re-invokes this engine with apply:true.

import { createHash, randomUUID } from "node:crypto";
import type { EvidenceManifest } from "@oscharko-dev/keiko-contracts";
import {
  canonicalise,
  createSession,
  DEFAULT_LIMITS,
  DryRunToolPort,
  HARNESS_VERSION,
  type AgentConfig,
  type HarnessEvent,
  type ModelPort,
  type RunCompletedEvent,
  type RunResult,
  type RunStartedEvent,
  type TaskInput,
  type TaskType,
} from "@oscharko-dev/keiko-harness";
import {
  generateUnitTests,
  investigateBug,
  type BugInvestigationInput,
  type BugInvestigationReport,
  type ToolResultArtifactWriter,
  type UnitTestWorkflowInput,
  type UnitTestWorkflowReport,
} from "@oscharko-dev/keiko-workflows";
import {
  buildVerificationPlan,
  detectScripts,
  type VerificationReport,
} from "@oscharko-dev/keiko-verification";
import { detectWorkspace, readWorkspaceFile } from "@oscharko-dev/keiko-workspace";
import type { EvidenceReport } from "@oscharko-dev/keiko-evidence";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { RunRequest } from "./run-request.js";
import {
  agentRunGovernanceFingerprintProjection,
  createAgentRunBudgetedModelPort,
  createAgentRunBudgetedSpawn,
  type AgentRunGovernanceBinding,
} from "./agent-run-governance.js";
import { QueueEventSink } from "./sink.js";
import {
  executeVerificationEnforced,
  probeNetworkIsolation,
} from "./editor/verificationExecution.js";
import type { ExecuteVerificationResult } from "./editor/verificationExecution.js";
import type { AppliableSnapshot, RunRegistry, RunStatus } from "./runs.js";
import {
  persistWorkflowEvidence,
  persistExplainEvidence,
  persistVerifyEvidence,
  type EvidencePersistContext,
  type RunIdentity,
} from "./evidence.js";
import { contentFreeErrorClass, emitServerDiagnostic } from "./diagnostics-log.js";
import { createWorkflowMemoryPort } from "./memory-workflow-port.js";
import { buildGovernedHandoffEvidence } from "./governed-workflow.js";
import { createServerHarnessToolShaper } from "./harness-tool-shaper.js";

export interface StartRunResult {
  readonly runId: string;
  readonly fingerprint: string;
}

export interface StartRunOptions {
  readonly runId?: string;
}

const KIND_TO_TASK_TYPE: Readonly<Record<RunRequest["kind"], TaskType>> = {
  "unit-tests": "generate-unit-tests",
  "bug-investigation": "investigate-bug",
  "explain-plan": "explain-plan",
  verify: "verify",
};

interface EngineContext {
  readonly request: RunRequest;
  readonly model: ModelPort;
  readonly registry: RunRegistry;
  readonly governance?: AgentRunGovernanceBinding | undefined;
  // Where terminated runs persist their redacted evidence manifest (AC5). Optional so the 3-arg
  // engine-context form in older tests still compiles; persistence is simply skipped when absent.
  readonly evidence?: EvidencePersistContext | undefined;
  readonly toolArtifacts?: ToolResultArtifactWriter | undefined;
  readonly memoryVault?: MemoryVaultStore | undefined;
  readonly memoryAuditRedactString?: ((input: string) => string) | undefined;
  readonly memoryCustomerIdentifierMatchers?: readonly RegExp[] | undefined;
  readonly verificationExecutor?:
    | ((
        args: Parameters<typeof executeVerificationEnforced>[0],
      ) => Promise<ExecuteVerificationResult>)
    | undefined;
}

// Assembles the workflow/task input by overlaying the request-level fields onto the client `input`
// object. The workflow validates the shape at its own boundary; the cast is the single typed
// boundary (no `any` — the value is built from validated primitives plus the passthrough record).
function unitTestInput(request: RunRequest): UnitTestWorkflowInput {
  return {
    ...request.input,
    modelId: request.modelId,
    apply: request.apply,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
  } as unknown as UnitTestWorkflowInput;
}

function bugInput(request: RunRequest): BugInvestigationInput {
  return {
    ...request.input,
    modelId: request.modelId,
    apply: request.apply,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
  } as unknown as BugInvestigationInput;
}

function explainTask(request: RunRequest): TaskInput {
  const root = workspaceRoot(request);
  const filePath = request.input.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { taskType: "explain-plan", input: request.input } as unknown as TaskInput;
  }
  const workspace = detectWorkspace(root);
  const file = readWorkspaceFile(workspace, filePath, { maxBytes: 32_768 });
  const context = [
    `--- ${file.relativePath}${file.truncated ? " (truncated)" : ""} ---`,
    file.text,
  ].join("\n");
  return { taskType: "explain-plan", input: { ...request.input, context } } as unknown as TaskInput;
}

function workspaceRoot(request: RunRequest): string {
  const root = request.input.workspaceRoot;
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("validated RunRequest is missing workspaceRoot");
  }
  return root;
}

export function workflowFingerprint(
  request: RunRequest,
  governance?: AgentRunGovernanceBinding,
): string {
  const taskType = KIND_TO_TASK_TYPE[request.kind];
  const canonical = canonicalise({
    taskType,
    taskInput: { taskType, input: request.input },
    limits: request.limits ?? {},
    modelId: request.modelId,
    governedHandoff: request.governedHandoff ?? null,
    governedHandoffSourceGroundedRunId: request.governedHandoffSourceGroundedRunId ?? null,
    governedHandoffVoiceAction: request.governedHandoffVoiceAction ?? null,
    governance:
      governance === undefined ? null : agentRunGovernanceFingerprintProjection(governance),
    workingDirectory: workspaceRoot(request),
    dryRun: true,
    harnessVersion: HARNESS_VERSION,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// dry-run-success (appliable) states per workflow. Only these produce an appliable snapshot for the
// gated apply path; any other terminal state is non-appliable (409 on apply).
function unitTestStatusToRun(status: UnitTestWorkflowReport["status"]): TerminalStatus {
  return status === "completed" || status === "dry-run" ? "completed" : statusOrFailed(status);
}

function bugStatusToRun(status: BugInvestigationReport["status"]): TerminalStatus {
  if (status === "fix-applied" || status === "fix-proposed" || status === "investigation-only") {
    return "completed";
  }
  return statusOrFailed(status);
}

function statusOrFailed(status: string): TerminalStatus {
  return status === "cancelled" ? "cancelled" : "failed";
}

function unitTestAppliable(
  request: RunRequest,
  report: UnitTestWorkflowReport,
): AppliableSnapshot | undefined {
  return report.status === "dry-run" && report.proposedDiff !== undefined
    ? {
        kind: "unit-tests",
        payload: request.input,
        limits: request.limits,
        governedHandoff: request.governedHandoff,
      }
    : undefined;
}

function bugAppliable(
  request: RunRequest,
  report: BugInvestigationReport,
): AppliableSnapshot | undefined {
  return report.status === "fix-proposed" && report.proposedDiff !== undefined
    ? {
        kind: "bug-investigation",
        payload: request.input,
        limits: request.limits,
        governedHandoff: request.governedHandoff,
      }
    : undefined;
}

type TerminalStatus = Exclude<RunStatus, "running">;

interface DispatchOutcome {
  readonly status: TerminalStatus;
  readonly report: unknown;
  readonly appliable: AppliableSnapshot | undefined;
  // Present only for an explain-plan run: the raw harness RunResult, used to fold usage for evidence.
  readonly result?: RunResult | undefined;
}

interface Dispatched {
  readonly result: Promise<DispatchOutcome>;
  readonly cancel: (reason?: string) => void;
}

function governedWorkflowPorts(ctx: EngineContext): {
  readonly model: ModelPort;
  readonly spawn?: typeof nodeSpawnFn | undefined;
} {
  if (ctx.governance === undefined) return { model: ctx.model };
  const budgetInput = {
    binding: ctx.governance,
    workspaceRoot: workspaceRoot(ctx.request),
    nowIso: (): string => new Date().toISOString(),
  };
  return {
    model: createAgentRunBudgetedModelPort({ ...budgetInput, model: ctx.model }),
    spawn: createAgentRunBudgetedSpawn({ ...budgetInput, spawn: nodeSpawnFn }),
  };
}

function cancelWorkflow(controller: AbortController): (reason?: string) => void {
  return (reason?: string): void => {
    controller.abort(reason);
  };
}

// probeNetworkIsolation spawns no untrusted command, but it IS real filesystem/OS probing that
// could throw for a workspaceRoot an earlier step already deleted or made unreadable. A governed
// run's verification step must still get an answer rather than crash the whole dispatch; fail
// closed (false) so the orchestrator's own fail-closed default applies exactly as if no probe had
// run at all — never fail open into an unenforced network:"none" step. A failure is still recorded
// through the server's single redacted diagnostic sink (no cwd, no raw error text — a content-free
// error class only) so a probe that starts failing is operator-visible, not silently swallowed.
export function probeNetworkIsolationSafely(cwd: string): boolean {
  try {
    return probeNetworkIsolation(cwd).available;
  } catch (error) {
    emitServerDiagnostic(undefined, {
      correlationId: randomUUID(),
      timestamp: new Date().toISOString(),
      operation: "workflow.network-isolation-probe",
      source: "run-engine.probeNetworkIsolationSafely",
      errorClass: contentFreeErrorClass(error),
      message: "Network isolation probe failed; verification enforcement defaults to fail-closed.",
    });
    return false;
  }
}

// Starts the underlying run for a workflow request: an AbortController drives cancellation (the
// workflow honours deps.signal), and the BFF-owned runId is injected as the workflow idSource so the
// streamed events carry the same runId the registry/SSE key on.
function dispatchWorkflow(ctx: EngineContext, sink: QueueEventSink, runId: string): Dispatched {
  const controller = new AbortController();
  const ports = governedWorkflowPorts(ctx);
  const commonDeps = {
    model: ports.model,
    ...(ports.spawn === undefined ? {} : { spawn: ports.spawn }),
    // Probe THIS host for an enforcing egress backend and hand the answer to the verify stage, the
    // same probe-then-enforce composition the editor verification path uses. Without it the stage
    // could only ever see "no backend available" and had to choose between denying every
    // network:"none" step and running model-authored code with inherited network (ADR-0043 D8).
    verificationEnforcedNetworkAvailable: probeNetworkIsolationSafely(workspaceRoot(ctx.request)),
    sink,
    signal: controller.signal,
    idSource: (): string => runId,
    ...(ctx.request.governedHandoff === undefined
      ? {}
      : { workflowHandoff: ctx.request.governedHandoff }),
    ...(ctx.memoryVault !== undefined && ctx.evidence !== undefined
      ? {
          memoryPort: createWorkflowMemoryPort({
            vault: ctx.memoryVault,
            evidenceStore: ctx.evidence.store,
            runId,
            redactString: ctx.memoryAuditRedactString ?? ((input: string): string => input),
            ...(ctx.memoryCustomerIdentifierMatchers === undefined
              ? {}
              : { customerIdentifierMatchers: ctx.memoryCustomerIdentifierMatchers }),
          }),
        }
      : {}),
  };
  if (ctx.request.kind === "unit-tests") {
    const result = generateUnitTests(unitTestInput(ctx.request), commonDeps).then((report) => ({
      status: unitTestStatusToRun(report.status),
      report,
      appliable: unitTestAppliable(ctx.request, report),
    }));
    return {
      result,
      cancel: cancelWorkflow(controller),
    };
  }
  const result = investigateBug(bugInput(ctx.request), commonDeps).then((report) => ({
    status: bugStatusToRun(report.status),
    report,
    appliable: bugAppliable(ctx.request, report),
  }));
  return {
    result,
    cancel: cancelWorkflow(controller),
  };
}

// Starts an explain-plan harness run. createSession returns the runId/fingerprint synchronously and
// exposes its own cancel(); the BFF reuses those rather than injecting an id.
function dispatchExplain(
  ctx: EngineContext,
  sink: QueueEventSink,
  reservedRunId?: string,
): { dispatched: Dispatched; runId: string; fingerprint: string } {
  const config: AgentConfig = {
    model: ctx.request.modelId,
    workingDirectory: workspaceRoot(ctx.request),
    dryRun: true,
    ...(ctx.request.limits === undefined ? {} : { limits: ctx.request.limits }),
  };
  const session = createSession(explainTask(ctx.request), config, {
    model: ctx.model,
    tools: new DryRunToolPort(),
    sink,
    shaperPort: createServerHarnessToolShaper({
      ...(ctx.toolArtifacts === undefined ? {} : { artifactWriter: ctx.toolArtifacts }),
    }),
    ...(reservedRunId === undefined ? {} : { idSource: { newRunId: (): string => reservedRunId } }),
  });
  const result = session.result.then((runResult): DispatchOutcome => ({
    status: runResult.outcome === "completed" ? "completed" : statusOrFailed(runResult.outcome),
    report: runResult.report ?? { status: runResult.outcome },
    appliable: undefined,
    result: runResult,
  }));
  return {
    dispatched: {
      result,
      cancel: (reason?: string): void => {
        session.cancel(reason);
      },
    },
    runId: session.runId,
    fingerprint: session.fingerprint,
  };
}

// Maps a VerificationStatus to the BFF RunStatus. Verify has no "appliable" snapshot — the gates
// either pass, fail/skip/deny (terminal), or are cancelled. `passed` → completed; `cancelled` →
// cancelled; every other terminal status (failed/skipped/denied/timed-out/resource-exceeded) is
// surfaced as `failed` so the registry stays in a known terminal state.
function verifyStatusToRun(status: VerificationReport["overallStatus"]): TerminalStatus {
  if (status === "passed") {
    return "completed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

// Builds a structurally-valid HarnessEvent envelope for a verify run's run:started/run:completed
// SSE events. Verify never enters the harness loop, but the SSE consumer keys on `type` and the
// shared envelope (`schemaVersion`/`runId`/`fingerprint`/`seq`/`ts`) so a deterministic shape lets
// the UI render a synthetic timeline alongside the workflow runs.
function emitVerifyStart(
  sink: QueueEventSink,
  runId: string,
  fingerprint: string,
  modelId: string,
): void {
  const event: RunStartedEvent = {
    schemaVersion: "1",
    runId,
    fingerprint,
    seq: 0,
    ts: Date.now(),
    type: "run:started",
    taskType: "verify",
    modelId,
    limits: DEFAULT_LIMITS,
  };
  sink.emit(event satisfies HarnessEvent);
}

function emitVerifyComplete(
  sink: QueueEventSink,
  runId: string,
  fingerprint: string,
  report: VerificationReport,
): void {
  const event: RunCompletedEvent = {
    schemaVersion: "1",
    runId,
    fingerprint,
    seq: 1,
    ts: Date.now(),
    type: "run:completed",
    report: `verify overall=${report.overallStatus}`,
  };
  sink.emit(event satisfies HarnessEvent);
}

// Starts a deterministic verify run via the verification orchestrator. No model loop is entered;
// the AbortController bridges the BFF cancel path to the orchestrator's signal. The two SSE events
// (`run:started`, `run:completed`) frame the run for any attached UI subscriber.
function dispatchVerify(ctx: EngineContext, sink: QueueEventSink, runId: string): Dispatched {
  const controller = new AbortController();
  const fingerprint = workflowFingerprint(ctx.request, ctx.governance);
  const root = workspaceRoot(ctx.request);
  emitVerifyStart(sink, runId, fingerprint, ctx.request.modelId);
  const result = runVerify(ctx, controller.signal, root).then((report): DispatchOutcome => {
    emitVerifyComplete(sink, runId, fingerprint, report);
    return {
      status: verifyStatusToRun(report.overallStatus),
      report,
      appliable: undefined,
    };
  });
  return {
    result,
    cancel: (reason?: string): void => {
      controller.abort(reason);
    },
  };
}

async function runVerify(
  ctx: EngineContext,
  signal: AbortSignal,
  root: string,
): Promise<VerificationReport> {
  const workspace = detectWorkspace(root);
  const catalog = detectScripts(workspace);
  const targetFiles = readTargetFiles(ctx.request.input.targetFiles);
  const plan = buildVerificationPlan(workspace, catalog, {
    ...(targetFiles === undefined ? {} : { changedFiles: targetFiles }),
  });
  const execute = ctx.verificationExecutor ?? executeVerificationEnforced;
  const { report } = await execute({ plan, workspace, signal, probeCwd: root });
  return report;
}

function readTargetFiles(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

// Registers the run, wires completion capture, and returns the synchronous {runId, fingerprint}. The
// caller (POST /api/runs) has already validated the request and resolved the ModelPort. Throws
// ActiveRunLimitError when the registry is at capacity (mapped to 429 upstream).
export function startRun(
  ctx: EngineContext,
  redactReport: (value: unknown) => unknown,
  options: StartRunOptions = {},
): StartRunResult {
  const sink = new QueueEventSink();
  const startedAt = Date.now();
  if (ctx.request.kind === "explain-plan") {
    const { dispatched, runId, fingerprint } = dispatchExplain(ctx, sink, options.runId);
    registerAndCapture(ctx, { runId, fingerprint, sink, startedAt }, dispatched, redactReport);
    return { runId, fingerprint };
  }
  if (ctx.request.kind === "verify") {
    const runId = options.runId ?? randomUUID();
    const fingerprint = workflowFingerprint(ctx.request, ctx.governance);
    const dispatched = dispatchVerify(ctx, sink, runId);
    registerAndCapture(ctx, { runId, fingerprint, sink, startedAt }, dispatched, redactReport);
    return { runId, fingerprint };
  }
  const runId = options.runId ?? randomUUID();
  const fingerprint = workflowFingerprint(ctx.request, ctx.governance);
  const dispatched = dispatchWorkflow(ctx, sink, runId);
  registerAndCapture(ctx, { runId, fingerprint, sink, startedAt }, dispatched, redactReport);
  return { runId, fingerprint };
}

interface RegisterIdentity {
  readonly runId: string;
  readonly fingerprint: string;
  readonly sink: QueueEventSink;
  readonly startedAt: number;
}

function registerAndCapture(
  ctx: EngineContext,
  identity: RegisterIdentity,
  dispatched: Dispatched,
  redactReport: (value: unknown) => unknown,
): void {
  ctx.registry.register({
    runId: identity.runId,
    fingerprint: identity.fingerprint,
    modelId: ctx.request.modelId,
    ...(ctx.governance === undefined ? {} : { governance: ctx.governance }),
    sink: identity.sink,
    cancel: dispatched.cancel,
  });
  void dispatched.result
    .then((outcome) => {
      const evidence = persistOutcome(ctx, identity, outcome);
      ctx.registry.complete(
        identity.runId,
        outcome.status,
        redactReport(attachEvidenceReport(outcome.report, evidence, ctx.governance)),
        outcome.appliable,
      );
    })
    .catch((error: unknown) => {
      ctx.registry.complete(
        identity.runId,
        "failed",
        redactReport({ error: String(error) }),
        undefined,
      );
    })
    .finally(() => {
      identity.sink.closeAll();
    });
}

// Persists a terminated run's redacted evidence manifest (AC5). Persistence errors intentionally
// surface to the final registry payload so a terminal UI run cannot silently omit required evidence.
function persistOutcome(
  ctx: EngineContext,
  identity: RegisterIdentity,
  outcome: DispatchOutcome,
): EvidenceReport | undefined {
  if (ctx.evidence === undefined) {
    return undefined;
  }
  const runIdentity: RunIdentity = {
    runId: identity.runId,
    fingerprint: identity.fingerprint,
    modelId: ctx.request.modelId,
    kind: ctx.request.kind,
    status: outcome.status,
    startedAt: identity.startedAt,
    finishedAt: Date.now(),
    workspaceRoot: workspaceRoot(ctx.request),
  };
  if (ctx.request.kind === "explain-plan" && outcome.result !== undefined) {
    return persistExplainEvidence(runIdentity, outcome.result, ctx.evidence);
  }
  if (ctx.request.kind === "verify") {
    return persistVerifyEvidence(
      runIdentity,
      ctx.evidence,
      ctx.request.governedHandoff === undefined
        ? undefined
        : buildGovernedHandoffEvidence({
            request: ctx.request.governedHandoff,
            sourceGroundedRunId: ctx.request.governedHandoffSourceGroundedRunId,
            voiceAction: ctx.request.governedHandoffVoiceAction,
          }),
    );
  }
  return persistWorkflowEvidence(
    runIdentity,
    outcome.report,
    identity.sink.buffered(),
    ctx.evidence,
    ctx.request.governedHandoff === undefined
      ? undefined
      : buildGovernedHandoffEvidence({
          request: ctx.request.governedHandoff,
          sourceGroundedRunId: ctx.request.governedHandoffSourceGroundedRunId,
          voiceAction: ctx.request.governedHandoffVoiceAction,
        }),
    evidenceAutonomyFor(ctx.governance),
  );
}

function evidenceAutonomyFor(
  governance: AgentRunGovernanceBinding | undefined,
): EvidenceManifest["autonomy"] | undefined {
  return governance === undefined
    ? undefined
    : {
        requestedMode: governance.requestedMode,
        effectiveMode: governance.effectiveMode,
        deploymentCeiling: governance.deploymentCeiling,
      };
}

function attachEvidenceReport(
  report: unknown,
  evidence: EvidenceReport | undefined,
  governance: AgentRunGovernanceBinding | undefined,
): unknown {
  const autonomy =
    governance === undefined
      ? undefined
      : {
          requestedMode: governance.requestedMode,
          effectiveMode: governance.effectiveMode,
          deploymentCeiling: governance.deploymentCeiling,
          connectorExecution: governance.connectorExecution,
          deliveryExecution: governance.deliveryExecution,
        };
  if (evidence === undefined && autonomy === undefined) return report;
  if (isRecord(report)) {
    return {
      ...report,
      ...(evidence === undefined ? {} : { evidence }),
      ...(autonomy === undefined ? {} : { autonomy }),
    };
  }
  return {
    report,
    ...(evidence === undefined ? {} : { evidence }),
    ...(autonomy === undefined ? {} : { autonomy }),
  };
}

// Re-invokes a workflow with apply:true through the SAME gated entry point (D8). This is the only
// place the engine sets apply:true; it does not construct a patch or write a file — the workflow's
// own guards (isSensitivePath, patch limits, #6 applyEnabled) fire at its boundary. Awaits the
// apply+verify result and returns the redacted report. The model is resolved by the caller.
export async function applyRun(
  snapshot: AppliableSnapshot,
  model: ModelPort,
  modelId: string,
  redactReport: (value: unknown) => unknown,
  governance?: AgentRunGovernanceBinding,
): Promise<unknown> {
  const input = isRecord(snapshot.payload) ? snapshot.payload : {};
  const limitsOverride = snapshot.limits !== undefined ? { limits: snapshot.limits } : {};
  const root = typeof input.workspaceRoot === "string" ? input.workspaceRoot : "";
  const budgetInput = {
    binding: governance,
    workspaceRoot: root,
    nowIso: (): string => new Date().toISOString(),
  };
  const executionModel =
    governance === undefined
      ? model
      : createAgentRunBudgetedModelPort({ ...budgetInput, binding: governance, model });
  const spawn =
    governance === undefined
      ? undefined
      : createAgentRunBudgetedSpawn({ ...budgetInput, binding: governance, spawn: nodeSpawnFn });
  const deps = {
    model: executionModel,
    ...(spawn === undefined ? {} : { spawn }),
    // Apply replays an accepted snapshot through the same verify stage the initial dispatch used
    // (dispatchWorkflow above); without this, a governed apply's network:"none" steps see no probe
    // result and are denied even on hosts an enforcing backend IS available on (ADR-0043 D8).
    verificationEnforcedNetworkAvailable: probeNetworkIsolationSafely(root),
    ...(snapshot.governedHandoff === undefined
      ? {}
      : { workflowHandoff: snapshot.governedHandoff }),
  };
  if (snapshot.kind === "unit-tests") {
    const report = await generateUnitTests(
      { ...input, modelId, apply: true, ...limitsOverride } as unknown as UnitTestWorkflowInput,
      deps,
    );
    return redactReport(report);
  }
  const report = await investigateBug(
    { ...input, modelId, apply: true, ...limitsOverride } as unknown as BugInvestigationInput,
    deps,
  );
  return redactReport(report);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { EngineContext };
