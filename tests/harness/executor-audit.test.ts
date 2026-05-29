// S-M1: the executor emits a redacted command:executed / patch:applied audit event (in addition
// to tool:call:completed) when a tool result carries `metadata`. Counts/flags only — never args,
// stdout, or file contents/paths reach the event stream.

import { describe, expect, it } from "vitest";
import { handleToolCall } from "../../src/harness/executor.js";
import type { ToolCallRequest, ToolCallResult, ToolPort } from "../../src/harness/ports.js";
import type { HarnessEvent } from "../../src/harness/types.js";
import { response, toolCall, buildContext } from "./_support.js";

function toolWith(result: Partial<ToolCallResult>): ToolPort {
  return {
    execute: (request: ToolCallRequest): Promise<ToolCallResult> =>
      Promise.resolve({
        toolCallId: request.toolCallId,
        output: "tool output",
        durationMs: 7,
        ...result,
      }),
    listTools: () => [],
  };
}

function eventsOfType<T extends HarnessEvent["type"]>(
  events: readonly HarnessEvent[],
  type: T,
): readonly (HarnessEvent & { type: T })[] {
  return events.filter((e): e is HarnessEvent & { type: T } => e.type === type);
}

describe("executor — S-M1 command:executed audit event", () => {
  it("emits command:executed with redacted counts/flags when a command tool returns metadata", async () => {
    const tools = toolWith({
      commandExecuted: true,
      metadata: { kind: "command", executable: "node", argCount: 2, exitCode: 0, timedOut: false },
    });
    const { ctx, sink } = buildContext({
      task: { taskType: "generate-unit-tests", input: { filePath: "src/a.ts" } },
      model: { call: () => Promise.resolve(response()) },
      tools,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });
    await handleToolCall(ctx);
    const emitted = eventsOfType(sink.events(), "command:executed");
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e?.executable).toBe("node");
    expect(e?.argCount).toBe(2);
    expect(e?.exitCode).toBe(0);
    expect(e?.timedOut).toBe(false);
    expect(e?.durationMs).toBe(7);
    // tool:call:completed is still emitted alongside it.
    expect(eventsOfType(sink.events(), "tool:call:completed")).toHaveLength(1);
  });

  it("carries a null exitCode and timedOut:true through unchanged", async () => {
    const tools = toolWith({
      commandExecuted: true,
      metadata: { kind: "command", executable: "npm", argCount: 1, exitCode: null, timedOut: true },
    });
    const { ctx, sink } = buildContext({
      task: { taskType: "generate-unit-tests", input: { filePath: "src/a.ts" } },
      model: { call: () => Promise.resolve(response()) },
      tools,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });
    await handleToolCall(ctx);
    const e = eventsOfType(sink.events(), "command:executed")[0];
    expect(e?.exitCode).toBeNull();
    expect(e?.timedOut).toBe(true);
  });
});

describe("executor — S-M1 patch:applied audit event", () => {
  it("emits patch:applied with file counts when a patch tool returns metadata", async () => {
    const tools = toolWith({
      metadata: { kind: "patch-apply", changedFiles: 3, created: 1, deleted: 2 },
    });
    const { ctx, sink } = buildContext({
      task: { taskType: "generate-unit-tests", input: { filePath: "src/a.ts" } },
      model: { call: () => Promise.resolve(response()) },
      tools,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "apply_patch")],
    });
    await handleToolCall(ctx);
    const emitted = eventsOfType(sink.events(), "patch:applied");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.changedFiles).toBe(3);
    expect(emitted[0]?.created).toBe(1);
    expect(emitted[0]?.deleted).toBe(2);
  });
});

describe("executor — S-M1 no metadata, no audit event", () => {
  it("emits neither command:executed nor patch:applied when the result has no metadata", async () => {
    const tools = toolWith({ output: "read output" });
    const { ctx, sink } = buildContext({
      task: { taskType: "generate-unit-tests", input: { filePath: "src/a.ts" } },
      model: { call: () => Promise.resolve(response()) },
      tools,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "read_file")],
    });
    await handleToolCall(ctx);
    expect(eventsOfType(sink.events(), "command:executed")).toHaveLength(0);
    expect(eventsOfType(sink.events(), "patch:applied")).toHaveLength(0);
    expect(eventsOfType(sink.events(), "tool:call:completed")).toHaveLength(1);
  });

  it("emits no audit event when the tool fails (no result, no metadata)", async () => {
    const tools: ToolPort = {
      execute: () => Promise.reject(new Error("boom")),
      listTools: () => [],
    };
    const { ctx, sink } = buildContext({
      task: { taskType: "generate-unit-tests", input: { filePath: "src/a.ts" } },
      model: { call: () => Promise.resolve(response()) },
      tools,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });
    await handleToolCall(ctx);
    expect(eventsOfType(sink.events(), "command:executed")).toHaveLength(0);
    expect(eventsOfType(sink.events(), "tool:call:failed")).toHaveLength(1);
  });
});
