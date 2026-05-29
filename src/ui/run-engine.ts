// The run engine (ADR-0011 D7/D8): it starts a dry-run-first run in the BACKGROUND and bridges it to
// the registry + streaming sink. It maps a validated RunRequest to the existing workflow / harness
// entry points UNCHANGED — generateUnitTests / investigateBug / createSession — and never calls a
// model directly or reimplements a guard. The BFF owns the runId (injected via the workflow idSource
// / read from the harness session) and a fingerprint so the 202 response is synchronous; completion
// is captured into the registry asynchronously. `apply` defaults false; the only place apply becomes
// true is the gated apply path (run-handlers), which re-invokes this engine with apply:true.

import { randomUUID } from "node:crypto";
import { DryRunToolPort } from "../harness/index.js";
import { createSession, type AgentConfig } from "../harness/index.js";
import type { ModelPort } from "../harness/index.js";
import { generateUnitTests, investigateBug } from "../workflows/index.js";
import type {
  UnitTestWorkflowInput,
  UnitTestWorkflowReport,
} from "../workflows/unit-tests/types.js";
import type {
  BugInvestigationInput,
  BugInvestigationReport,
} from "../workflows/bug-investigation/types.js";
import type { TaskInput } from "../harness/index.js";
import type { RunRequest } from "./run-request.js";
import { QueueEventSink } from "./sink.js";
import type { AppliableSnapshot, RunRegistry, RunStatus } from "./runs.js";

export interface StartRunResult {
  readonly runId: string;
  readonly fingerprint: string;
}

interface EngineContext {
  readonly request: RunRequest;
  readonly model: ModelPort;
  readonly registry: RunRegistry;
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
  return { taskType: "explain-plan", input: request.input } as unknown as TaskInput;
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
    ? { kind: "unit-tests", payload: request.input }
    : undefined;
}

function bugAppliable(
  request: RunRequest,
  report: BugInvestigationReport,
): AppliableSnapshot | undefined {
  return report.status === "fix-proposed" && report.proposedDiff !== undefined
    ? { kind: "bug-investigation", payload: request.input }
    : undefined;
}

type TerminalStatus = Exclude<RunStatus, "running">;

interface DispatchOutcome {
  readonly status: TerminalStatus;
  readonly report: unknown;
  readonly appliable: AppliableSnapshot | undefined;
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
  };
  if (ctx.request.kind === "unit-tests") {
    const result = generateUnitTests(unitTestInput(ctx.request), commonDeps).then((report) => ({
      status: unitTestStatusToRun(report.status),
      report,
      appliable: unitTestAppliable(ctx.request, report),
    }));
    return { result, cancel: (reason?: string): void => controller.abort(reason) };
  }
  const result = investigateBug(bugInput(ctx.request), commonDeps).then((report) => ({
    status: bugStatusToRun(report.status),
    report,
    appliable: bugAppliable(ctx.request, report),
  }));
  return { result, cancel: (reason?: string): void => controller.abort(reason) };
}

// Starts an explain-plan harness run. createSession returns the runId/fingerprint synchronously and
// exposes its own cancel(); the BFF reuses those rather than injecting an id.
function dispatchExplain(
  ctx: EngineContext,
  sink: QueueEventSink,
): { dispatched: Dispatched; runId: string; fingerprint: string } {
  const config: AgentConfig = { model: ctx.request.modelId, workingDirectory: ".", dryRun: true };
  const session = createSession(explainTask(ctx.request), config, {
    model: ctx.model,
    tools: new DryRunToolPort(),
    sink,
  });
  const result = session.result.then(
    (runResult): DispatchOutcome => ({
      status: runResult.outcome === "completed" ? "completed" : statusOrFailed(runResult.outcome),
      report: runResult.report ?? { status: runResult.outcome },
      appliable: undefined,
    }),
  );
  return {
    dispatched: { result, cancel: (reason?: string): void => session.cancel(reason) },
    runId: session.runId,
    fingerprint: session.fingerprint,
  };
}

// Registers the run, wires completion capture, and returns the synchronous {runId, fingerprint}. The
// caller (POST /api/runs) has already validated the request and resolved the ModelPort. Throws
// ActiveRunLimitError when the registry is at capacity (mapped to 429 upstream).
export function startRun(ctx: EngineContext, redactReport: (value: unknown) => unknown): StartRunResult {
  const sink = new QueueEventSink();
  if (ctx.request.kind === "explain-plan") {
    const { dispatched, runId, fingerprint } = dispatchExplain(ctx, sink);
    registerAndCapture(ctx.registry, { runId, fingerprint, sink }, dispatched, redactReport);
    return { runId, fingerprint };
  }
  const runId = randomUUID();
  const fingerprint = randomUUID().slice(0, 16);
  const dispatched = dispatchWorkflow(ctx, sink, runId);
  registerAndCapture(ctx.registry, { runId, fingerprint, sink }, dispatched, redactReport);
  return { runId, fingerprint };
}

interface RegisterIdentity {
  readonly runId: string;
  readonly fingerprint: string;
  readonly sink: QueueEventSink;
}

function registerAndCapture(
  registry: RunRegistry,
  identity: RegisterIdentity,
  dispatched: Dispatched,
  redactReport: (value: unknown) => unknown,
): void {
  registry.register({
    runId: identity.runId,
    fingerprint: identity.fingerprint,
    sink: identity.sink,
    cancel: dispatched.cancel,
  });
  void dispatched.result
    .then((outcome) => {
      registry.complete(
        identity.runId,
        outcome.status,
        redactReport(outcome.report),
        outcome.appliable,
      );
    })
    .catch((error: unknown) => {
      registry.complete(identity.runId, "failed", { error: String(error) }, undefined);
    })
    .finally(() => {
      identity.sink.closeAll();
    });
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
  const deps = { model };
  if (snapshot.kind === "unit-tests") {
    const report = await generateUnitTests(
      { ...input, modelId, apply: true } as unknown as UnitTestWorkflowInput,
      deps,
    );
    return redactReport(report);
  }
  const report = await investigateBug(
    { ...input, modelId, apply: true } as unknown as BugInvestigationInput,
    deps,
  );
  return redactReport(report);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { EngineContext };
