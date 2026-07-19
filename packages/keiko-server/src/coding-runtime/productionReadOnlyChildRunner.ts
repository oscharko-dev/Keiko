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

export function createProductionReadOnlyChildRunner(
  deps: ProductionReadOnlyChildRunnerDeps,
): ReadOnlyChildRunner {
  return {
    run: (input): Promise<ReturnTypeForRunner> => runChildSession(deps, input),
  };
}

type ReturnTypeForRunner = Awaited<ReturnType<ReadOnlyChildRunner["run"]>>;

async function runChildSession(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
): Promise<ReturnTypeForRunner> {
  const model = deps.modelPortFactory(input.modelId);
  if (model === undefined) throw new Error("child-model-unavailable");
  const state = { successfulReads: 0 };
  const session = createSession(
    {
      taskType: "editor-agent-turn",
      input: { goal: input.objective, sessionId: input.envelope.childRunId },
    },
    {
      model: input.modelId,
      workingDirectory: input.workspaceRoot,
      dryRun: true,
      limits: {
        maxIterations: Math.max(2, input.maxToolCalls + 1),
        maxModelCalls: Math.max(2, input.maxToolCalls + 1),
        maxToolCalls: input.maxToolCalls,
        maxCommandExecutions: 0,
        maxContextBytes: 128_000,
        maxPatchBytes: 0,
        maxWallTimeMs: 120_000,
        maxFailureAttempts: 1,
      },
    },
    { model, tools: readOnlyTools(deps, input, state), sink: TRANSIENT_SINK },
  );
  const abort = (): void => session.cancel("parent-stopped");
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
  state: { successfulReads: number },
): ToolPort {
  return {
    listTools: (): readonly ToolDefinition[] => [READ_FILE_TOOL],
    execute: (request): Promise<ToolCallResult> => executeRead(deps, input, state, request),
  };
}

async function executeRead(
  deps: ProductionReadOnlyChildRunnerDeps,
  input: ReadOnlyChildRunnerInput,
  state: { successfulReads: number },
  request: ToolCallRequest,
): Promise<ToolCallResult> {
  if (request.toolName !== "read_file" || !input.gate({ toolClass: "workspace-read" }).ok) {
    return result(request.toolCallId, '{"status":"denied"}');
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
