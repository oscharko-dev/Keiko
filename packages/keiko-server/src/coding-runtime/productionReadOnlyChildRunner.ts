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
  successfulReads: number;
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
function childLimits(maxToolCalls: number): Parameters<typeof createSession>[1]["limits"] {
  return {
    maxIterations: Math.max(4, maxToolCalls * 2 + 2),
    maxModelCalls: Math.max(3, maxToolCalls + 2),
    maxToolCalls,
    maxCommandExecutions: 0,
    maxContextBytes: 128_000,
    maxPatchBytes: 0,
    maxWallTimeMs: 120_000,
    maxFailureAttempts: 1,
  };
}

/** Until the session exists a denial can only latch its reason; no tool call can run before then. */
function newChildRunState(): ChildRunState {
  const state: ChildRunState = {
    successfulReads: 0,
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

function buildChildSession(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  model: ModelPort,
  state: ChildRunState,
): ReturnType<typeof createSession> {
  const tools = readOnlyTools(deps, input, state);
  return createSession(
    {
      taskType: "editor-agent-turn",
      input: { goal: input.objective, sessionId: input.envelope.childRunId },
    },
    {
      model: input.modelId,
      workingDirectory: input.workspaceRoot,
      dryRun: false,
      limits: childLimits(input.maxToolCalls),
    },
    {
      model: budgetedChildModel(model, deps.reservePromptTokens),
      tools,
      // #3407: dispatch through the mandatory catalog path again, bound to the reserved
      // `child` profile. Every call still runs through readOnlyTools(...).execute() below --
      // the same parent-gate-before-read and stop-on-denial semantics, unmodified.
      bindToolCatalog: createLegacyPortCatalogFactory(
        CHILD_CATALOG,
        CHILD_PROFILE,
        tools,
        CHILD_HANDLER_ATTESTATIONS,
      ),
      sink: TRANSIENT_SINK,
      // KEIKO-0726 (#3323): a real, tool-using production call site — a read-only child can loop
      // through many keiko_child_workspace_read rounds against a 128KB budget and genuinely grow
      // past it, so this is where the gap this issue closes actually gets exercised.
      compactionPort: serverHarnessContextCompactor,
    },
  );
}

async function runChildSession(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
): Promise<ReturnTypeForRunner> {
  const model = deps.modelPortFactory(input.modelId);
  if (model === undefined) throw new Error("child-model-unavailable");
  const state = newChildRunState();
  const session = buildChildSession(deps, input, model, state);
  bindSessionCancellation(state, session);
  const abort = (): void => {
    session.cancel("parent-stopped");
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  try {
    const result = await session.result;
    logHarnessContextCompactionEvents(result.events, {
      parentCorrelationId: input.envelope.parentRunId,
    });
    if (result.outcome === "failed") throw new Error("child-session-failed");
    const summary = result.report ?? result.outcome;
    return {
      resultCount: state.successfulReads,
      resultDigest: {
        outcome: "known",
        value: createHash("sha256").update(summary, "utf8").digest("hex"),
      },
    };
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
}

function budgetedChildModel(
  model: ModelPort,
  reservePromptTokens: (promptTokens: number) => boolean,
): ModelPort {
  const stream = model.callStream;
  return {
    call: (request, signal): Promise<Awaited<ReturnType<ModelPort["call"]>>> => {
      reserveChildPrompt(request, reservePromptTokens);
      return model.call(request, signal);
    },
    ...(stream === undefined
      ? {}
      : {
          callStream: (request: GatewayRequest, signal: AbortSignal) =>
            budgetedChildStream(stream, request, signal, reservePromptTokens),
        }),
  };
}

async function* budgetedChildStream(
  stream: NonNullable<ModelPort["callStream"]>,
  request: GatewayRequest,
  signal: AbortSignal,
  reservePromptTokens: (promptTokens: number) => boolean,
): AsyncIterable<GatewayStreamChunk> {
  reserveChildPrompt(request, reservePromptTokens);
  yield* stream(request, signal);
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
    request.toolCatalog === undefined ? [] : [JSON.stringify(request.toolCatalog.projection.tools)];
  const responseFormat =
    request.responseFormat === undefined ? [] : [JSON.stringify(request.responseFormat)];
  return Math.max(1, estimateTokensForSegments([...messages, ...tools, ...responseFormat]));
}

function readOnlyTools(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  state: ChildRunState,
): ToolPort {
  return {
    listTools: (): readonly ToolDefinition[] => [CHILD_READ_TOOL],
    execute: (request): Promise<ToolCallResult> => executeRead(deps, input, state, request),
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
  state: ChildRunState,
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
  state.successfulReads += 1;
  return result(request.toolCallId, read.text);
}

function result(toolCallId: string, output: string): ToolCallResult {
  return { toolCallId, output, durationMs: 0, commandExecuted: false };
}
