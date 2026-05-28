// `keiko run` — the dry-run task command. It builds an AgentSession wired to deterministic
// mocked model/tool fixtures (no provider call, no real tools), renders the HarnessEvent
// stream to CliIo, and makes ZERO filesystem writes. Real model/tool wiring arrives with
// the provider config path and issue #6; this command exercises the harness end-to-end.

import type { GatewayRequest, NormalizedResponse } from "../gateway/types.js";
import { DryRunToolPort } from "../harness/adapters.js";
import { createSession, type AgentConfig } from "../harness/session.js";
import { CliEventSink } from "../harness/sinks.js";
import type { ModelPort } from "../harness/ports.js";
import type { RunResult, TaskInput, TaskType } from "../harness/types.js";
import type { CliIo } from "./runner.js";

const TASK_TYPES: ReadonlySet<string> = new Set<TaskType>([
  "generate-unit-tests",
  "investigate-bug",
  "explain-plan",
]);

const USAGE = `Usage:
  keiko run explain-plan --file PATH [--question TEXT]
  keiko run generate-unit-tests --file PATH [--function NAME]
  keiko run investigate-bug --description TEXT [--file PATH]

All tasks run in dry-run mode: a patch is proposed as an event, never written to disk.
`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

// A deterministic, dependency-free model that returns a canned final response. It never
// requests tools, so the dry-run path is reproducible regardless of task type.
function mockModelPort(): ModelPort {
  return {
    call: (request: GatewayRequest): Promise<NormalizedResponse> =>
      Promise.resolve({
        modelId: request.modelId,
        content: "--- a/file\n+++ b/file\n+// dry-run proposed change\n",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "dry-run",
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: 1,
          costClass: "low",
        },
      }),
  };
}

function parseTask(taskType: TaskType, args: readonly string[]): TaskInput | null {
  const file = flag(args, "--file");
  if (taskType === "explain-plan") {
    if (file === undefined) {
      return null;
    }
    const question = flag(args, "--question");
    return { taskType, input: { filePath: file, question } };
  }
  if (taskType === "generate-unit-tests") {
    if (file === undefined) {
      return null;
    }
    return { taskType, input: { filePath: file, targetFunction: flag(args, "--function") } };
  }
  const description = flag(args, "--description");
  if (description === undefined) {
    return null;
  }
  return {
    taskType,
    input: { description, filePaths: file === undefined ? undefined : [file] },
  };
}

function outcomeToExitCode(result: RunResult, io: CliIo): number {
  if (result.outcome === "completed") {
    io.out(`run ${result.runId} completed (fingerprint ${result.fingerprint})\n`);
    return 0;
  }
  if (result.outcome === "cancelled") {
    io.err(`run ${result.runId} cancelled\n`);
    return 1;
  }
  const category = result.failure?.category ?? "HARNESS_INTERNAL";
  io.err(`run ${result.runId} ${result.outcome} [${category}]: ${result.failure?.message ?? ""}\n`);
  return 1;
}

export async function runAgentCli(args: readonly string[], io: CliIo): Promise<number> {
  const taskType = args[0];
  if (taskType === undefined || !TASK_TYPES.has(taskType)) {
    io.err(taskType === undefined ? USAGE : `keiko run: unknown task type: ${taskType}\n${USAGE}`);
    return 2;
  }
  const task = parseTask(taskType as TaskType, args.slice(1));
  if (task === null) {
    io.err(`keiko run: missing required argument for ${taskType}.\n${USAGE}`);
    return 2;
  }
  const config: AgentConfig = { model: "mock-model", workingDirectory: ".", dryRun: true };
  const session = createSession(task, config, {
    model: mockModelPort(),
    tools: new DryRunToolPort(),
    sink: new CliEventSink(io),
  });
  return outcomeToExitCode(await session.result, io);
}
