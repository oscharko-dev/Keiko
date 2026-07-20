import { createHash } from "node:crypto";

import {
  createSession,
  type EventSink,
  type ModelPort,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolPort,
} from "@oscharko-dev/keiko-harness";
import type { ToolDefinition } from "@oscharko-dev/keiko-model-gateway";

import type { ReadOnlyChildRunner, ReadOnlyChildRunnerInput } from "./readOnlyChildOrchestrator.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

export interface ProductionReadOnlyChildRunnerDeps {
  readonly modelPortFactory: (modelId: string) => ModelPort | undefined;
  readonly secureWorkspaceTextRead: SecureWorkspaceTextReadPort;
}

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read one bounded repository text file through the parent authority.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { relativePath: { type: "string", minLength: 1, maxLength: 512 } },
    required: ["relativePath"],
  },
};

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
 * read tool that reports `commandExecuted: false`, so the counter is never consumed — the zero here
 * is now a stated invariant, not a workaround.
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

async function runChildSession(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
): Promise<ReturnTypeForRunner> {
  const model = deps.modelPortFactory(input.modelId);
  if (model === undefined) throw new Error("child-model-unavailable");
  const state = newChildRunState();
  const session = createSession(
    {
      taskType: "editor-agent-turn",
      input: { goal: input.objective, sessionId: input.envelope.childRunId },
    },
    {
      model: input.modelId,
      workingDirectory: input.workspaceRoot,
      dryRun: true,
      limits: childLimits(input.maxToolCalls),
    },
    { model, tools: readOnlyTools(deps, input, state), sink: TRANSIENT_SINK },
  );
  bindSessionCancellation(state, session);
  const abort = (): void => {
    session.cancel("parent-stopped");
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  try {
    const result = await session.result;
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

function readOnlyTools(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  state: ChildRunState,
): ToolPort {
  return {
    listTools: (): readonly ToolDefinition[] => [READ_FILE_TOOL],
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
 * A tool name other than `read_file` cannot be charged against an action class, because the child is
 * offered exactly one tool and anything else is a fabricated call. That is an anomaly, not a policy
 * decision, so it terminates the session directly instead of being routed at a class it does not
 * belong to.
 */
async function executeRead(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  state: ChildRunState,
  request: ToolCallRequest,
): Promise<ToolCallResult> {
  if (request.toolName !== "read_file") {
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
  return { toolCallId, output, durationMs: 0 };
}
