import { describe, expect, it } from "vitest";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { runLoop } from "./loop.js";
import type { ModelPort } from "./ports.js";
import type { HarnessEvent, TaskInput } from "./types.js";
import {
  buildContext,
  recordingTool,
  response,
  scriptedModel,
  stubClock,
  toolCall,
} from "./_support.js";

const EXPLAIN: TaskInput = { taskType: "explain-plan", input: { filePath: "src/foo.ts" } };
const GENERATE: TaskInput = {
  taskType: "generate-unit-tests",
  input: { filePath: "src/foo.ts" },
};
const INVESTIGATE: TaskInput = { taskType: "investigate-bug", input: { description: "bug" } };

function states(events: readonly HarnessEvent[]): string[] {
  return events.filter((e) => e.type === "state:transition").map((e) => e.to);
}

function failureCategory(events: readonly HarnessEvent[]): string | undefined {
  const failed = events.find((e) => e.type === "run:failed");
  return failed?.type === "run:failed" ? failed.failure.category : undefined;
}

describe("runLoop — normal flow", () => {
  it("drives explain-plan to completed with the documented state path", async () => {
    const { port } = scriptedModel([response({ content: "explanation" })]);
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("completed");
    expect(states(sink.events())).toEqual([
      "planning",
      "context-selection",
      "model-call",
      "reporting",
      "completed",
    ]);
    expect(sink.events().at(-1)?.type).toBe("run:completed");
  });

  it("drives generate-unit-tests through patch-proposal and verification", async () => {
    const { port } = scriptedModel([response({ content: "--- a/foo\n+++ b/foo\n+test" })]);
    const { ctx, sink } = buildContext({ task: GENERATE, model: port });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("completed");
    expect(states(sink.events())).toContain("patch-proposal");
    expect(states(sink.events())).toContain("verification");
    expect(ctx.patchDiff).toContain("+test");
  });
});

describe("runLoop — task-type routing", () => {
  it("explain-plan never enters tool-call, patch-proposal, or verification", async () => {
    const { port } = scriptedModel([response({ content: "explanation" })]);
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port });
    await runLoop(ctx);
    const visited = states(sink.events());
    expect(visited).not.toContain("tool-call");
    expect(visited).not.toContain("patch-proposal");
    expect(visited).not.toContain("verification");
    expect(ctx.patchDiff).toBeUndefined();
  });

  it("explain-plan returning tool_calls is a HARNESS_INTERNAL failure", async () => {
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1")] }),
    ]);
    const tool = recordingTool();
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port, tools: tool.port });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("failed");
    expect(failureCategory(sink.events())).toBe("HARNESS_INTERNAL");
    expect(tool.calls()).toHaveLength(0);
  });

  it("investigate-bug runs the tool loop then proposes a patch", async () => {
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1")] }),
      response({ content: "--- a/x\n+++ b/x\n+fix" }),
    ]);
    const tool = recordingTool([{ name: "read_file", description: "read", parameters: {} }]);
    const { ctx, sink } = buildContext({ task: INVESTIGATE, model: port, tools: tool.port });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("completed");
    expect(tool.calls()).toHaveLength(1);
    const types = sink.events().map((e) => e.type);
    expect(types).toContain("tool:call:started");
    expect(types).toContain("tool:call:completed");
    expect(ctx.patchDiff).toContain("+fix");
  });

  it("preserves assistant tool calls and tool_call_id for the follow-up model turn", async () => {
    const firstToolCall = toolCall("t1");
    const scripted = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [firstToolCall] }),
      response({ content: "--- a/x\n+++ b/x\n+fix" }),
    ]);
    const tool = recordingTool([{ name: "read_file", description: "read", parameters: {} }]);
    const { ctx } = buildContext({ task: INVESTIGATE, model: scripted.port, tools: tool.port });
    await runLoop(ctx);
    const secondRequest = scripted.requests()[1];
    expect(secondRequest?.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [firstToolCall],
    });
    expect(secondRequest?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "t1",
      content: "tool output",
    });
  });
});

describe("runLoop — cancellation", () => {
  it("aborts before tool-call: transitions to cancelled with no tool execution or patch", async () => {
    const controller = new AbortController();
    // First call requests a tool; the abort fires before the loop re-enters tool-call.
    const port: ModelPort = {
      call: (): Promise<NormalizedResponse> => {
        controller.abort("cancel before tools");
        return Promise.resolve(
          response({ finishReason: "tool_calls", toolCalls: [toolCall("t1")] }),
        );
      },
    };
    const tool = recordingTool([{ name: "read_file", description: "r", parameters: {} }]);
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: tool.port,
      signal: controller.signal,
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("cancelled");
    expect(tool.calls()).toHaveLength(0);
    expect(ctx.patchDiff).toBeUndefined();
    expect(sink.events().at(-1)?.type).toBe("run:cancelled");
  });

  it("propagates the run signal to the ToolPort on execution", async () => {
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1")] }),
      response({ content: "--- a/x\n+++ b/x\n+fix" }),
    ]);
    const tool = recordingTool([{ name: "read_file", description: "r", parameters: {} }]);
    const controller = new AbortController();
    const { ctx } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: tool.port,
      signal: controller.signal,
    });
    await runLoop(ctx);
    expect(tool.calls()[0]?.signal).toBe(controller.signal);
  });
});

describe("runLoop — limit breaches each map to their category", () => {
  it("maxIterations -> HARNESS_LIMIT_ITERATIONS", async () => {
    // A model that always asks for tools forces verification to re-plan and loop.
    const { port } = scriptedModel([response({ content: "" })]);
    const { ctx, sink } = buildContext({
      task: GENERATE,
      model: port,
      limits: { maxIterations: 1, maxFailureAttempts: 99 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_ITERATIONS");
  });

  it("maxModelCalls -> HARNESS_LIMIT_MODEL_CALLS", async () => {
    const { port } = scriptedModel([response({ content: "" })]);
    const { ctx, sink } = buildContext({
      task: GENERATE,
      model: port,
      limits: { maxModelCalls: 0 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_MODEL_CALLS");
  });

  it("maxToolCalls -> HARNESS_LIMIT_TOOL_CALLS", async () => {
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1"), toolCall("t2")] }),
    ]);
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      limits: { maxToolCalls: 1 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_TOOL_CALLS");
  });

  it("maxContextBytes -> HARNESS_LIMIT_CONTEXT_SIZE", async () => {
    const { port } = scriptedModel([response()]);
    const { ctx, sink } = buildContext({
      task: EXPLAIN,
      model: port,
      limits: { maxContextBytes: 1 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_CONTEXT_SIZE");
  });

  it("maxWallTimeMs -> HARNESS_LIMIT_WALL_TIME", async () => {
    const { clock, set } = stubClock(0);
    const { port } = scriptedModel([response()]);
    const { ctx, sink } = buildContext({
      task: EXPLAIN,
      model: port,
      clock,
      limits: { maxWallTimeMs: 100 },
    });
    set(1000);
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_WALL_TIME");
  });

  it("maxPatchBytes -> HARNESS_LIMIT_PATCH_SIZE", async () => {
    const { port } = scriptedModel([response({ content: "x".repeat(1000) })]);
    const { ctx, sink } = buildContext({
      task: GENERATE,
      model: port,
      limits: { maxPatchBytes: 10 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_PATCH_SIZE");
  });

  it("maxFailureAttempts -> HARNESS_LIMIT_FAILURE_ATTEMPTS on repeated retryable model errors", async () => {
    const { TransportError } = await import("@oscharko-dev/keiko-model-gateway");
    const { port } = scriptedModel([new TransportError("boom")]);
    const { ctx, sink } = buildContext({
      task: GENERATE,
      model: port,
      limits: { maxFailureAttempts: 2 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_FAILURE_ATTEMPTS");
  });

  it("maxCommandExecutions -> HARNESS_LIMIT_COMMAND_EXECUTIONS when a tool reports commandExecuted", async () => {
    // A model that ALWAYS asks for one tool call; the tool reports commandExecuted:true so the
    // executor increments commandExecutions until the (previously dead) guard trips on re-entry.
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1", "run_command")] }),
    ]);
    const commandTool: import("./ports.js").ToolPort = {
      execute: (req) =>
        Promise.resolve({
          toolCallId: req.toolCallId,
          output: "ran",
          durationMs: 0,
          commandExecuted: true,
        }),
      listTools: () => [{ name: "run_command", description: "run", parameters: {} }],
    };
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: commandTool,
      limits: { maxCommandExecutions: 1 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_COMMAND_EXECUTIONS");
  });

  it("maxCommandExecutions blocks a second command in the same tool-call batch", async () => {
    const { port } = scriptedModel([
      response({
        finishReason: "tool_calls",
        toolCalls: [toolCall("t1", "run_command"), toolCall("t2", "run_command")],
      }),
      response({ content: "should not run" }),
    ]);
    const seen: string[] = [];
    const commandTool: import("./ports.js").ToolPort = {
      execute: (req) => {
        seen.push(req.toolCallId);
        return Promise.resolve({
          toolCallId: req.toolCallId,
          output: "ran",
          durationMs: 0,
          commandExecuted: true,
        });
      },
      listTools: () => [{ name: "run_command", description: "run", parameters: {} }],
    };
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: commandTool,
      limits: { maxCommandExecutions: 1 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_COMMAND_EXECUTIONS");
    expect(seen).toEqual(["t1"]);
  });

  it("commandExecuted:false never trips maxCommandExecutions", async () => {
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1", "read_file")] }),
      response({ content: "--- a/x\n+++ b/x\n+fix" }),
    ]);
    const readTool: import("./ports.js").ToolPort = {
      execute: (req) =>
        Promise.resolve({
          toolCallId: req.toolCallId,
          output: "content",
          durationMs: 0,
          commandExecuted: false,
        }),
      listTools: () => [{ name: "read_file", description: "read", parameters: {} }],
    };
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: readTool,
      limits: { maxCommandExecutions: 1 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("completed");
    expect(ctx.counters.commandExecutions).toBe(0);
    void sink;
  });

  it("non-retryable model error -> failed with HARNESS_MODEL_ERROR", async () => {
    const { AuthenticationError } = await import("@oscharko-dev/keiko-model-gateway");
    const { port } = scriptedModel([new AuthenticationError("nope")]);
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("failed");
    expect(failureCategory(sink.events())).toBe("HARNESS_MODEL_ERROR");
  });

  it("tool execution error -> failed with HARNESS_TOOL_ERROR", async () => {
    const { port } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1")] }),
      response({ content: "should not run" }),
    ]);
    const failingTool: import("./ports.js").ToolPort = {
      execute: () => Promise.reject(new Error("tool exploded")),
      listTools: () => [{ name: "read_file", description: "read", parameters: {} }],
    };
    const { ctx, sink } = buildContext({ task: INVESTIGATE, model: port, tools: failingTool });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("failed");
    expect(failureCategory(sink.events())).toBe("HARNESS_TOOL_ERROR");
  });

  it("aborts between tool calls in a multi-tool batch", async () => {
    const controller = new AbortController();
    const { port } = scriptedModel([
      response({
        finishReason: "tool_calls",
        toolCalls: [toolCall("t1"), toolCall("t2")],
      }),
      response({ content: "should not run" }),
    ]);
    const seen: string[] = [];
    const abortingTool: import("./ports.js").ToolPort = {
      execute: (req) => {
        seen.push(req.toolCallId);
        controller.abort("after first tool");
        return Promise.resolve({ toolCallId: req.toolCallId, output: "content", durationMs: 0 });
      },
      listTools: () => [{ name: "read_file", description: "read", parameters: {} }],
    };
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: abortingTool,
      signal: controller.signal,
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("cancelled");
    expect(seen).toEqual(["t1"]);
    const cancelled = sink.events().find((e) => e.type === "run:cancelled");
    expect(cancelled?.type).toBe("run:cancelled");
    if (cancelled?.type === "run:cancelled") {
      expect(cancelled.atState).toBe("tool-call");
    }
  });

  it("context limit after tool-call -> HARNESS_LIMIT_CONTEXT_SIZE on second model-call entry", async () => {
    // The first model call returns tool_calls; the tool returns a large output that pushes
    // ctx.messages past maxContextBytes before the second model-call entry guard fires.
    const largeOutput = "x".repeat(500);
    const { port, calls } = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("t1")] }),
      response({ content: "should not reach here" }),
    ]);
    const largeTool: import("./ports.js").ToolPort = {
      execute: (req) =>
        Promise.resolve({ toolCallId: req.toolCallId, output: largeOutput, durationMs: 0 }),
      listTools: () => [{ name: "read_file", description: "read", parameters: {} }],
    };
    // maxContextBytes must be large enough to pass the initial context-selection check
    // but small enough to fail after the tool output is appended to ctx.messages.
    const { ctx, sink } = buildContext({
      task: INVESTIGATE,
      model: port,
      tools: largeTool,
      limits: { maxContextBytes: 400 },
    });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("limit-exceeded");
    expect(failureCategory(sink.events())).toBe("HARNESS_LIMIT_CONTEXT_SIZE");
    // The entry guard fires BEFORE the second model call is dispatched; only one call was made.
    expect(calls()).toBe(1);
  });

  it("wall-time exact boundary: elapsed === maxWallTimeMs does not exceed; elapsed > maxWallTimeMs does", async () => {
    // elapsed === limit → run proceeds (> is the operator, not >=)
    const { clock: clockA, set: setA } = stubClock(0);
    const { port: portA } = scriptedModel([response()]);
    const { ctx: ctxA } = buildContext({
      task: EXPLAIN,
      model: portA,
      clock: clockA,
      limits: { maxWallTimeMs: 100 },
    });
    setA(100); // elapsed === 100, limit === 100 → NOT exceeded
    const outcomeA = await runLoop(ctxA);
    expect(outcomeA).toBe("completed");

    // elapsed > limit → limit-exceeded
    const { clock: clockB, set: setB } = stubClock(0);
    const { port: portB } = scriptedModel([response()]);
    const { ctx: ctxB, sink: sinkB } = buildContext({
      task: EXPLAIN,
      model: portB,
      clock: clockB,
      limits: { maxWallTimeMs: 100 },
    });
    setB(101); // elapsed === 101 > 100 → exceeded
    const outcomeB = await runLoop(ctxB);
    expect(outcomeB).toBe("limit-exceeded");
    expect(failureCategory(sinkB.events())).toBe("HARNESS_LIMIT_WALL_TIME");
  });
});
