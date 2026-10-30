import { createHash } from "node:crypto";

import { estimateTokensForSegments } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  createLegacyPortCatalogFactory,
  createSession,
  type EventSink,
  type ModelPort,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolPort,
} from "@oscharko-dev/keiko-harness";
import {
  CHILD_WORKSPACE_READ_ALIAS,
  CHILD_WORKSPACE_READ_HANDLER_REQUIREMENT,
  childRegistrationSet,
  createKeikoToolCatalog,
  gatewayToolDefinitions,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";

import {
  logHarnessContextCompactionEvents,
  serverHarnessContextCompactor,
} from "../harness-context-compactor.js";
import type { ReadOnlyChildRunner, ReadOnlyChildRunnerInput } from "./readOnlyChildOrchestrator.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

export interface ProductionReadOnlyChildRunnerDeps {
  readonly modelPortFactory: (modelId: string) => ModelPort | undefined;
  readonly secureWorkspaceTextRead: SecureWorkspaceTextReadPort;
  readonly reservePromptTokens: (promptTokens: number) => boolean;
}

// #3407: `keiko.child.workspace.read@1` is the reserved canonical identity (ADR-0175 D2) for the
// one tool a read-only child is offered; the descriptor -- not a hand-typed duplicate -- is the
// single source for both this tool's advertised ToolDefinition and its catalog binding.
const CHILD_PROFILE = { id: "child", version: 1 } as const;
const CHILD_CATALOG = createKeikoToolCatalog([childRegistrationSet()]);

function requireChildReadTool(): ToolDefinition {
  const [tool] = gatewayToolDefinitions(CHILD_CATALOG, CHILD_PROFILE);
  if (tool === undefined) throw new TypeError("Missing child.workspace.read descriptor");
  return tool;
}
const CHILD_READ_TOOL = requireChildReadTool();
const CHILD_HANDLER_ATTESTATIONS = [
  {
    alias: CHILD_WORKSPACE_READ_ALIAS,
    handlerId: CHILD_WORKSPACE_READ_HANDLER_REQUIREMENT.id,
    handlerVersion: CHILD_WORKSPACE_READ_HANDLER_REQUIREMENT.contractVersion,
    catalogAction: CHILD_WORKSPACE_READ_ALIAS,
  },
] as const;

const TRANSIENT_SINK: EventSink = { emit: (): void => undefined };

/**
 * Per-run mutable state. `stop` latches the first governance reason and cancels the harness session,
 * so a gate denial terminates the child instead of merely answering one tool call with "denied".
 */
interface ChildRunState {
  stoppedReason: string | undefined;
  stop: (reason: string) => void;
}

export function createProductionReadOnlyChildRunner(
  deps: ProductionReadOnlyChildRunnerDeps,
): ReadOnlyChildRunner {
  return {
    run: (input): Promise<ReturnTypeForRunner> => runChildSession(deps, input),
  };
}

type ReturnTypeForRunner = Awaited<ReturnType<ReadOnlyChildRunner["run"]>>;

/**
 * The child's harness budget.
 *
 * `maxIterations`/`maxModelCalls` must clear the cost of a real tool-calling turn (ask → run tool →
 * report), or the child ends `limit-exceeded` having read nothing while still reporting a completed
 * outcome.
 *
 * `maxCommandExecutions: 0` states the child's containment directly: this envelope must never run
 * a subprocess. The harness enforces the budget where a command actually executes (issue #2638), so
 * a zero command budget no longer refuses read-only tool calls. The tool surface offers exactly one
 * read tool whose `ToolCallResult` sets `commandExecuted: false` explicitly, so the counter is
 * never consumed — the zero here is now a stated invariant, not a workaround.
 */
function childLimits(
  maxToolCalls: number,
  maxWallTimeMs: number,
): Parameters<typeof createSession>[1]["limits"] {
  return {
    maxIterations: Math.max(4, maxToolCalls * 2 + 2),
    maxModelCalls: Math.max(3, maxToolCalls + 2),
    maxToolCalls,
    maxCommandExecutions: 0,
    maxContextBytes: 128_000,
    maxPatchBytes: 0,
    maxWallTimeMs,
    maxFailureAttempts: 1,
  };
}

/** Until the session exists a denial can only latch its reason; no tool call can run before then. */
function newChildRunState(): ChildRunState {
  const state: ChildRunState = {
    stoppedReason: undefined,
    stop: (reason): void => {
      state.stoppedReason ??= reason;
    },
  };
  return state;
}

/**
 * Rebinds `stop` onto the live session so a gate denial cancels the child instead of only answering
 * one tool call "denied". A reason latched before this point is applied immediately.
 */
function bindSessionCancellation(
  state: ChildRunState,
  session: ReturnType<typeof createSession>,
): void {
  state.stop = (reason): void => {
    state.stoppedReason ??= reason;
    session.cancel(reason);
  };
  if (state.stoppedReason !== undefined) session.cancel(state.stoppedReason);
}

/** The child's harness wall time when the caller states none (#2387). */
const CHILD_DEFAULT_WALL_TIME_MS = 120_000;

/**
 * The tool surface of one bounded read-only harness session: the catalog and reserved profile it
 * is bound to, the handler attestations, and the port whose `execute` routes every call through
 * the session's governance gate (ADR-0175 D2).
 */
export interface ReadOnlyHarnessToolset {
  readonly catalog: ReturnType<typeof createKeikoToolCatalog>;
  readonly profile: { readonly id: string; readonly version: number };
  readonly attestations: Parameters<typeof createLegacyPortCatalogFactory>[3];
  readonly tools: ToolPort;
}

/** One bounded read-only harness session (#2387; generalized for the #4136 counter-check). */
export interface ReadOnlyHarnessSessionSpec {
  readonly model: ModelPort;
  readonly reservePromptTokens: (promptTokens: number) => boolean;
  readonly sessionId: string;
  readonly objective: string;
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly maxToolCalls: number;
  readonly maxWallTimeMs?: number | undefined;
  readonly signal: AbortSignal;
  readonly parentCorrelationId: string;
  readonly toolset: (stop: (reason: string) => void) => ReadOnlyHarnessToolset;
  /** Provider-reported usage of each completed model call; counts only. */
  readonly onUsage?: ((usage: ReadOnlyHarnessModelUsage) => void) | undefined;
}

export interface ReadOnlyHarnessModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReadOnlyHarnessSessionOutcome {
  readonly outcome: string;
  /** The session's closing summary; never logged, only digested by the child runner. */
  readonly summary: string;
  /** The reason a governance denial latched, if one stopped the session. */
  readonly stoppedReason: string | undefined;
}

function buildHarnessSession(
  spec: ReadOnlyHarnessSessionSpec,
  state: ChildRunState,
): ReturnType<typeof createSession> {
  const toolset = spec.toolset((reason) => {
    state.stop(reason);
  });
  return createSession(
    {
      taskType: "editor-agent-turn",
      input: { goal: spec.objective, sessionId: spec.sessionId },
    },
    {
      model: spec.modelId,
      workingDirectory: spec.workspaceRoot,
      dryRun: false,
      limits: childLimits(spec.maxToolCalls, spec.maxWallTimeMs ?? CHILD_DEFAULT_WALL_TIME_MS),
    },
    {
      model: budgetedChildModel(spec.model, spec.reservePromptTokens, spec.onUsage),
      tools: toolset.tools,
      // #3407: dispatch through the mandatory catalog path, bound to the session's reserved
      // profile. Every call still runs through the toolset's execute() -- the same
      // parent-gate-before-read and stop-on-denial semantics, unmodified.
      bindToolCatalog: createLegacyPortCatalogFactory(
        toolset.catalog,
        toolset.profile,
        toolset.tools,
        toolset.attestations,
      ),
      sink: TRANSIENT_SINK,
      // KEIKO-0726 (#3323): a real, tool-using production call site — a read-only session can loop
      // through many read rounds against a 128KB budget and genuinely grow past it, so this is
      // where the gap this issue closes actually gets exercised.
      compactionPort: serverHarnessContextCompactor,
    },
  );
}

/**
 * Runs one bounded read-only harness session to its end. A governance denial cancels the session;
 * the caller's signal cancels it as `parent-stopped`. A failed session throws.
 */
export async function runReadOnlyHarnessSession(
  spec: ReadOnlyHarnessSessionSpec,
): Promise<ReadOnlyHarnessSessionOutcome> {
  const state = newChildRunState();
  const session = buildHarnessSession(spec, state);
  bindSessionCancellation(state, session);
  const abort = (): void => {
    session.cancel("parent-stopped");
  };
  spec.signal.addEventListener("abort", abort, { once: true });
  if (spec.signal.aborted) abort();
  try {
    const result = await session.result;
    logHarnessContextCompactionEvents(result.events, {
      parentCorrelationId: spec.parentCorrelationId,
    });
    if (result.outcome === "failed") throw new Error("child-session-failed");
    return {
      outcome: result.outcome,
      summary: result.report ?? result.outcome,
      stoppedReason: state.stoppedReason,
    };
  } finally {
    spec.signal.removeEventListener("abort", abort);
  }
}

async function runChildSession(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
): Promise<ReturnTypeForRunner> {
  const model = deps.modelPortFactory(input.modelId);
  if (model === undefined) throw new Error("child-model-unavailable");
  let successfulReads = 0;
  const finished = await runReadOnlyHarnessSession({
    model,
    reservePromptTokens: deps.reservePromptTokens,
    sessionId: input.envelope.childRunId,
    objective: input.objective,
    modelId: input.modelId,
    workspaceRoot: input.workspaceRoot,
    maxToolCalls: input.maxToolCalls,
    signal: input.signal,
    parentCorrelationId: input.envelope.parentRunId,
    toolset: (stop) => ({
      catalog: CHILD_CATALOG,
      profile: CHILD_PROFILE,
      attestations: CHILD_HANDLER_ATTESTATIONS,
      tools: readOnlyTools(deps, input, stop, () => {
        successfulReads += 1;
      }),
    }),
  });
  return {
    resultCount: successfulReads,
    resultDigest: {
      outcome: "known",
      value: createHash("sha256").update(finished.summary, "utf8").digest("hex"),
    },
  };
}

function budgetedChildModel(
  model: ModelPort,
  reservePromptTokens: (promptTokens: number) => boolean,
  onUsage: ReadOnlyHarnessSessionSpec["onUsage"],
): ModelPort {
  const stream = model.callStream;
  return {
    call: async (request, signal): Promise<Awaited<ReturnType<ModelPort["call"]>>> => {
      reserveChildPrompt(request, reservePromptTokens);
      const response = await model.call(request, signal);
      reportUsage(onUsage, response);
      return response;
    },
    ...(stream === undefined
      ? {}
      : {
          callStream: (request: GatewayRequest, signal: AbortSignal) =>
            budgetedChildStream(stream, request, signal, reservePromptTokens, onUsage),
        }),
  };
}

async function* budgetedChildStream(
  stream: NonNullable<ModelPort["callStream"]>,
  request: GatewayRequest,
  signal: AbortSignal,
  reservePromptTokens: (promptTokens: number) => boolean,
  onUsage: ReadOnlyHarnessSessionSpec["onUsage"],
): AsyncIterable<GatewayStreamChunk> {
  reserveChildPrompt(request, reservePromptTokens);
  for await (const chunk of stream(request, signal)) {
    if (chunk.type === "done") reportUsage(onUsage, chunk.response);
    yield chunk;
  }
}

function reportUsage(
  onUsage: ReadOnlyHarnessSessionSpec["onUsage"],
  response: {
    readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
  },
): void {
  onUsage?.({
    inputTokens: response.usage.promptTokens,
    outputTokens: response.usage.completionTokens,
  });
}

function reserveChildPrompt(
  request: GatewayRequest,
  reservePromptTokens: (promptTokens: number) => boolean,
): void {
  if (!reservePromptTokens(childPromptTokenEstimate(request))) {
    throw new Error("child-prompt-budget-exhausted");
  }
}

function childPromptTokenEstimate(request: GatewayRequest): number {
  const messages = request.messages.map((message) =>
    JSON.stringify({
      role: message.role,
      content: message.content,
      contentParts: message.contentParts,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
    }),
  );
  const tools =
    request.toolCatalog === undefined
      ? []
      : [
          JSON.stringify(
            request.toolCatalog.kind === "native"
              ? request.toolCatalog.tools
              : request.toolCatalog.projection.tools,
          ),
        ];
  const responseFormat =
    request.responseFormat === undefined ? [] : [JSON.stringify(request.responseFormat)];
  return Math.max(1, estimateTokensForSegments([...messages, ...tools, ...responseFormat]));
}

function readOnlyTools(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  stop: (reason: string) => void,
  onRead: () => void,
): ToolPort {
  return {
    listTools: (): readonly ToolDefinition[] => [CHILD_READ_TOOL],
    execute: (request): Promise<ToolCallResult> =>
      executeRead(deps, input, { stop, onRead }, request),
  };
}

const DENIED = '{"status":"denied"}';

/**
 * The `ReadOnlyChildRunnerInput` contract is explicit: route EVERY intended tool call through the
 * parent gate and STOP on a non-ok decision. Both halves matter.
 *
 * Denying a call and letting the session keep iterating would leave a child running after the
 * parent's authority, budget, or one-layer rule already terminated it — the gate's latched terminal
 * would be reported while the child kept spending model calls against the same parent budget. So a
 * denial cancels the session rather than answering with a denied tool result alone.
 *
 * A tool name other than `keiko_child_workspace_read` cannot be charged against an action class,
 * because the child is offered exactly one tool and anything else is a fabricated call. That is an
 * anomaly, not a policy decision, so it terminates the session directly instead of being routed at
 * a class it does not belong to.
 */
async function executeRead(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  state: { readonly stop: (reason: string) => void; readonly onRead: () => void },
  request: ToolCallRequest,
): Promise<ToolCallResult> {
  if (request.toolName !== CHILD_WORKSPACE_READ_ALIAS) {
    state.stop("tool-not-offered");
    return result(request.toolCallId, DENIED);
  }
  const decision = input.gate({ toolClass: "workspace-read" });
  if (!decision.ok) {
    state.stop(decision.reasonCode);
    return result(request.toolCallId, DENIED);
  }
  const relativePath = request.arguments.relativePath;
  if (typeof relativePath !== "string") {
    return result(request.toolCallId, '{"status":"invalid"}');
  }
  const read = await deps.secureWorkspaceTextRead.readText({
    relativePath,
    signal: request.signal,
  });
  if (!read.ok) return result(request.toolCallId, `{"status":"${read.reason}"}`);
  state.onRead();
  return result(request.toolCallId, read.text);
}

function result(toolCallId: string, output: string): ToolCallResult {
  return { toolCallId, output, durationMs: 0, commandExecuted: false };
}
