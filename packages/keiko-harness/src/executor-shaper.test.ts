// ADR-0055 D4 (PR4-W3): the executor additively attaches a shaped observation to a ToolCallResult
// via the OPTIONAL injected HarnessShaperPort, WITHOUT changing the model-facing role:tool message
// content or contextBytes. These tests pin the three hard gates:
//   - shapedObservationAttached: with a port injected, the run accumulates a valid observation.
//   - modelOutputUnchanged / contextBytesUnchanged: the role:tool ChatMessage content is
//     byte-identical and contextBytes(messages) is identical with vs without the port.
//   - noPortUnchanged: with no port (every existing caller), messages are identical to today.

import { describe, expect, it } from "vitest";
import { validateContextToolObservation } from "@oscharko-dev/keiko-contracts";
import type { ContextToolObservation } from "@oscharko-dev/keiko-contracts";
import { contextBytes } from "./context.js";
import { handleToolCall } from "./executor.js";
import type { ToolCallRequest, ToolCallResult, ToolPort } from "./ports.js";
import type { HarnessShaperInput, HarnessShaperPort } from "./shaper-port.js";
import { response, toolCall, buildContext } from "./_support.js";

const COMMAND_SANDBOX = {
  envAllowlist: ["PATH"],
  network: "inherit" as const,
  maxOutputBytes: 1_024,
  timeoutMs: 500,
  terminationGraceMs: 50,
  cwdRequested: false,
};

function commandTool(output: string): ToolPort {
  return {
    execute: (request: ToolCallRequest): Promise<ToolCallResult> =>
      Promise.resolve({
        toolCallId: request.toolCallId,
        output,
        durationMs: 7,
        commandExecuted: true,
        metadata: {
          kind: "command",
          executable: "node",
          argCount: 0,
          exitCode: 0,
          timedOut: false,
          sandbox: COMMAND_SANDBOX,
        },
      }),
    listTools: () => [],
  };
}

// A deterministic fake port that records its inputs and returns a structurally-valid
// command observation. It does NOT depend on keiko-workflows — it stands in for the injected
// production shaper.
function fakeShaper(): {
  port: HarnessShaperPort;
  inputs: () => readonly HarnessShaperInput[];
} {
  const seen: HarnessShaperInput[] = [];
  const observation: ContextToolObservation = {
    kind: "command",
    observationId: "obs-1",
    exitCode: 0,
    durationMs: 7,
    timedOut: false,
    truncated: false,
    excerpts: [{ stream: "stdout", bytes: 2, text: "ok" }],
    injectionSignalCount: 0,
    hasCriticalInjectionSignal: false,
  };
  return {
    inputs: () => seen,
    port: (input): ContextToolObservation | undefined => {
      seen.push(input);
      return input.result.metadata?.kind === "command" ? observation : undefined;
    },
  };
}

const TASK = { taskType: "generate-unit-tests", input: { filePath: "src/a.ts" } } as const;
const OUTPUT = JSON.stringify({ exitCode: 0, signal: null, stdout: "ok", stderr: "" });

describe("executor — ADR-0055 D4 shaped-observation attach", () => {
  it("shapedObservationAttached: a valid observation is accumulated when a port is injected", async () => {
    const shaper = fakeShaper();
    const { ctx } = buildContext({
      task: TASK,
      model: { call: () => Promise.resolve(response()) },
      tools: commandTool(OUTPUT),
      shaperPort: shaper.port,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });

    await handleToolCall(ctx);

    expect(ctx.shapedObservations).toHaveLength(1);
    const observation = ctx.shapedObservations[0];
    expect(observation?.kind).toBe("command");
    expect(validateContextToolObservation(observation)).toEqual({ ok: true });
    // The port saw the completed result and the originating call's identity.
    expect(shaper.inputs()).toHaveLength(1);
    expect(shaper.inputs()[0]?.toolName).toBe("run_command");
    expect(shaper.inputs()[0]?.toolCallId).toBe("c1");
    expect(shaper.inputs()[0]?.result.output).toBe(OUTPUT);
  });

  it("modelOutputUnchanged + contextBytesUnchanged: the role:tool message is byte-identical with vs without a port", async () => {
    async function run(withPort: boolean): Promise<{ messages: unknown; bytes: number }> {
      const shaper = fakeShaper();
      const { ctx } = buildContext({
        task: TASK,
        model: { call: () => Promise.resolve(response()) },
        tools: commandTool(OUTPUT),
        ...(withPort ? { shaperPort: shaper.port } : {}),
      });
      ctx.lastResponse = response({
        finishReason: "tool_calls",
        toolCalls: [toolCall("c1", "run_command")],
      });
      await handleToolCall(ctx);
      return { messages: ctx.messages, bytes: contextBytes(ctx.messages) };
    }

    const withPort = await run(true);
    const withoutPort = await run(false);

    expect(JSON.stringify(withPort.messages)).toBe(JSON.stringify(withoutPort.messages));
    expect(withPort.bytes).toBe(withoutPort.bytes);
    // The accumulated observation never leaks into the serialized message array.
    expect(JSON.stringify(withPort.messages)).not.toContain("observationId");
    expect(JSON.stringify(withPort.messages)).not.toContain("shapedObservation");
  });

  it("noPortUnchanged: with no port the accumulator stays empty and the tool message uses output verbatim", async () => {
    const { ctx } = buildContext({
      task: TASK,
      model: { call: () => Promise.resolve(response()) },
      tools: commandTool(OUTPUT),
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });

    await handleToolCall(ctx);

    expect(ctx.shapedObservations).toHaveLength(0);
    const last = ctx.messages[ctx.messages.length - 1];
    expect(last?.role).toBe("tool");
    expect(last?.content).toBe(OUTPUT);
  });

  it("a port returning undefined leaves the result un-enriched and the accumulator empty", async () => {
    // A port that never shapes (e.g. read-only tool) is a no-op for the result and accumulator.
    const port: HarnessShaperPort = () => undefined;
    const { ctx } = buildContext({
      task: TASK,
      model: { call: () => Promise.resolve(response()) },
      tools: commandTool(OUTPUT),
      shaperPort: port,
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });

    await handleToolCall(ctx);

    expect(ctx.shapedObservations).toHaveLength(0);
    expect(ctx.messages[ctx.messages.length - 1]?.content).toBe(OUTPUT);
  });
});
