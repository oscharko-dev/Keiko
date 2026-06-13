// The run engine (ADR-0011 D7/D8): it starts a dry-run-first run in the BACKGROUND and bridges it to
// the registry + streaming sink. It maps a validated RunRequest to the existing workflow / harness
// entry points UNCHANGED — generateUnitTests / investigateBug / createSession — and never calls a
// model directly or reimplements a guard. The BFF owns the runId (injected via the workflow idSource
// / read from the harness session) and a fingerprint so the 202 response is synchronous; completion
// is captured into the registry asynchronously. `apply` defaults false; the only place apply becomes
// true is the gated apply path (run-handlers), which re-invokes this engine with apply:true.

import { createHash, randomUUID } from "node:crypto";
import { DryRunToolPort } from "@oscharko-dev/keiko-harness";
import {
  canonicalise,
  createSession,
  HARNESS_VERSION,
  type AgentConfig,
} from "@oscharko-dev/keiko-harness";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { generateUnitTests, investigateBug } from "@oscharko-dev/keiko-workflows";
import {
  buildVerificationPlan,
  detectScripts,
  runVerification,
  type VerificationReport,
} from "@oscharko-dev/keiko-verification";
import { detectWorkspace, readWorkspaceFile } from "@oscharko-dev/keiko-workspace";
import type { UnitTestWorkflowInput, UnitTestWorkflowReport } from "@oscharko-dev/keiko-workflows";
import type { BugInvestigationInput, BugInvestigationReport } from "@oscharko-dev/keiko-workflows";
import type {
  HarnessEvent,
  RunCompletedEvent,
  RunStartedEvent,
  TaskInput,
  RunResult,
  TaskType,
} from "@oscharko-dev/keiko-harness";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import type { EvidenceReport } from "@oscharko-dev/keiko-evidence";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { RunRequest } from "./run-request.js";
import { QueueEventSink } from "./sink.js";
import type { AppliableSnapshot, RunRegistry, RunStatus } from "./runs.js";
import {
  persistWorkflowEvidence,
  persistExplainEvidence,
  persistVerifyEvidence,
  type EvidencePersistContext,
  type RunIdentity,
} from "./evidence.js";
import { createWorkflowMemoryPort } from "./memory-workflow-port.js";
import { buildGovernedHandoffEvidence } from "./governed-workflow.js";

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
  // Where terminated runs persist their redacted evidence manifest (AC5). Optional so the 3-arg
  // engine-context form in older tests still compiles; persistence is simply skipped when absent.
  readonly evidence?: EvidencePersistContext | undefined;
  readonly memoryVault?: MemoryVaultStore | undefined;
  readonly memoryAuditRedactString?: ((input: string) => string) | undefined;
  readonly memoryCustomerIdentifierMatchers?: readonly RegExp[] | undefined;
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

function workflowFingerprint(request: RunRequest): string {
  const taskType = KIND_TO_TASK_TYPE[request.kind];
  const canonical = canonicalise({
    taskType,
    taskInput: { taskType, input: request.input },
    limits: request.limits ?? {},
    modelId: request.modelId,
    governedHandoff: request.governedHandoff ?? null,
    governedHandoffSourceGroundedRunId: request.governedHandoffSourceGroundedRunId ?? null,
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

// Starts the underlying run for a workflow request: an AbortController drives cancellation (the
// workflow honours deps.signal), and the BFF-owned runId is injected as the workflow idSource so the
// streamed events carry the same runId the registry/SSE key on.
function dispatchWorkflow(ctx: EngineContext, sink: QueueEventSink, runId: string): Dispatched {
  const controller = new AbortController();
  const commonDeps = {
    model: ctx.model,
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
      cancel: (reason?: string): void => {
        controller.abort(reason);
      },
    };
  }
  const result = investigateBug(bugInput(ctx.request), commonDeps).then((report) => ({
    status: bugStatusToRun(report.status),
    report,
    appliable: bugAppliable(ctx.request, report),
  }));
  return {
    result,
    cancel: (reason?: string): void => {
      controller.abort(reason);
    },
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
    ...(reservedRunId === undefined ? {} : { idSource: { newRunId: (): string => reservedRunId } }),
  });
  const result = session.result.then(
    (runResult): DispatchOutcome => ({
      status: runResult.outcome === "completed" ? "completed" : statusOrFailed(runResult.outcome),
      report: runResult.report ?? { status: runResult.outcome },
      appliable: undefined,
      result: runResult,
    }),
  );
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
  const fingerprint = workflowFingerprint(ctx.request);
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
  return runVerification(plan, { workspace, signal });
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
    const fingerprint = workflowFingerprint(ctx.request);
    const dispatched = dispatchVerify(ctx, sink, runId);
    registerAndCapture(ctx, { runId, fingerprint, sink, startedAt }, dispatched, redactReport);
    return { runId, fingerprint };
  }
  const runId = options.runId ?? randomUUID();
  const fingerprint = workflowFingerprint(ctx.request);
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
    sink: identity.sink,
    cancel: dispatched.cancel,
  });
  void dispatched.result
    .then((outcome) => {
      const evidence = persistOutcome(ctx, identity, outcome);
      ctx.registry.complete(
        identity.runId,
        outcome.status,
        redactReport(attachEvidenceReport(outcome.report, evidence)),
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
        }),
  );
}

function attachEvidenceReport(report: unknown, evidence: EvidenceReport | undefined): unknown {
  if (evidence === undefined) {
    return report;
  }
  if (isRecord(report)) {
    return { ...report, evidence };
  }
  return { report, evidence };
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
): Promise<unknown> {
  const input = isRecord(snapshot.payload) ? snapshot.payload : {};
  const limitsOverride = snapshot.limits !== undefined ? { limits: snapshot.limits } : {};
  const deps =
    snapshot.governedHandoff === undefined
      ? { model }
      : { model, workflowHandoff: snapshot.governedHandoff };
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
