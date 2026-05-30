// S-M1: the executor emits a redacted command:executed / patch:applied audit event (in addition
// to tool:call:completed) when a tool result carries `metadata`. Counts/flags only — never args,
// stdout, or file contents/paths reach the event stream.

import { describe, expect, it } from "vitest";
import { handleToolCall } from "../../src/harness/executor.js";
import type { ToolCallRequest, ToolCallResult, ToolPort } from "../../src/harness/ports.js";
import type { HarnessEvent } from "../../src/harness/types.js";
import { CommandDeniedError } from "../../src/tools/errors.js";
import { PathDeniedError } from "../../src/workspace/errors.js";
import { response, toolCall, buildContext } from "./_support.js";

const COMMAND_SANDBOX = {
  envAllowlist: ["PATH", "TZ"],
  network: "inherit" as const,
  maxOutputBytes: 1_024,
  timeoutMs: 500,
  terminationGraceMs: 50,
  cwdRequested: false,
};

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
      metadata: {
        kind: "command",
        executable: "node",
        argCount: 2,
        exitCode: 0,
        timedOut: false,
        sandbox: COMMAND_SANDBOX,
      },
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

  it("emits sandbox:configured with safe names and limits when command metadata is present", async () => {
    const tools = toolWith({
      commandExecuted: true,
      metadata: {
        kind: "command",
        executable: "node",
        argCount: 2,
        exitCode: 0,
        timedOut: false,
        sandbox: { ...COMMAND_SANDBOX, cwdRequested: true },
      },
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
    const emitted = eventsOfType(sink.events(), "sandbox:configured");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      envAllowlist: ["PATH", "TZ"],
      network: "inherit",
      maxOutputBytes: 1_024,
      timeoutMs: 500,
      terminationGraceMs: 50,
      cwdRequested: true,
    });
    expect(JSON.stringify(emitted[0])).not.toContain("SECRET");
  });

  it("carries a null exitCode and timedOut:true through unchanged", async () => {
    const tools = toolWith({
      commandExecuted: true,
      metadata: {
        kind: "command",
        executable: "npm",
        argCount: 1,
        exitCode: null,
        timedOut: true,
        sandbox: COMMAND_SANDBOX,
      },
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
  it("emits no command/sandbox/patch event when the result has no metadata", async () => {
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
    expect(eventsOfType(sink.events(), "sandbox:configured")).toHaveLength(0);
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
    expect(eventsOfType(sink.events(), "sandbox:configured")).toHaveLength(0);
    expect(eventsOfType(sink.events(), "tool:call:failed")).toHaveLength(1);
  });

  it("preserves stable tool error codes on tool:call:failed", async () => {
    const tools: ToolPort = {
      execute: () => Promise.reject(new CommandDeniedError("command denied", "node")),
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
    expect(eventsOfType(sink.events(), "tool:call:failed")[0]?.errorCode).toBe(
      "TOOL_COMMAND_DENIED",
    );
  });

  it("preserves stable workspace error codes on tool:call:failed", async () => {
    const tools: ToolPort = {
      execute: () =>
        Promise.reject(new PathDeniedError("path matches an always-on deny pattern", ".env")),
      listTools: () => [],
    };
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
    expect(eventsOfType(sink.events(), "tool:call:failed")[0]?.errorCode).toBe(
      "WORKSPACE_PATH_DENIED",
    );
  });
});
