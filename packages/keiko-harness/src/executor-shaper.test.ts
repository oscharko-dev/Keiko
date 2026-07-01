// ADR-0055 D4 (PR4-W3): the executor additively attaches a shaped observation to a ToolCallResult
// via the OPTIONAL injected HarnessShaperPort. Small outputs stay byte-identical; budget-pressure
// outputs may use the bounded shaped observation instead of aborting. These tests pin the gates:
//   - shapedObservationAttached: with a port injected, the run accumulates a valid observation.
//   - modelOutputUnchanged / contextBytesUnchanged: the role:tool ChatMessage content is
//     byte-identical and contextBytes(messages) is identical with vs without the port when raw fits.
//   - oversizedRawUsesCompaction: raw 512KB-class output continues when the shaped message fits.
//   - noPortUnchanged: with no port (every existing caller), messages are identical to today.

import { describe, expect, it } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  validateContextToolObservation,
} from "@oscharko-dev/keiko-contracts";
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

function sequenceCommandTool(outputs: readonly string[]): ToolPort {
  let index = 0;
  return {
    execute: (request: ToolCallRequest): Promise<ToolCallResult> => {
      const output = outputs[Math.min(index, outputs.length - 1)] ?? "";
      index += 1;
      return Promise.resolve({
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
      });
    },
    listTools: () => [],
  };
}

// A deterministic fake port that records its inputs and returns a structurally-valid
// command observation. It does NOT depend on keiko-workflows — it stands in for the injected
// production shaper.
function fakeShaper(observation: ContextToolObservation = DEFAULT_OBSERVATION): {
  port: HarnessShaperPort;
  inputs: () => readonly HarnessShaperInput[];
} {
  const seen: HarnessShaperInput[] = [];
  return {
    inputs: () => seen,
    port: (input): ContextToolObservation | undefined => {
      seen.push(input);
      return input.result.metadata?.kind === "command" ? observation : undefined;
    },
  };
}

const DEFAULT_OBSERVATION: ContextToolObservation = {
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

const FAILURE_OBSERVATION: ContextToolObservation = {
  kind: "command",
  observationId: "obs-long-output",
  exitCode: 1,
  durationMs: 42,
  timedOut: false,
  truncated: true,
  omittedByteCount: 520_000,
  excerpts: [{ stream: "stderr", bytes: 28, text: "expected failure assertion" }],
  injectionSignalCount: 0,
  hasCriticalInjectionSignal: false,
  rehydration: {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "tool-observations",
    kind: "tool-result",
    artifactId: "artifact-long-output",
    itemCount: 1,
    approxTokens: 130_000,
    notPersistedReason: "raw output exceeded live prompt budget",
  },
};

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

  it("oversizedRawUsesCompaction: a valid shaped observation keeps a 512KB-class tool result under budget", async () => {
    const rawMarker = "raw-output-sentinel";
    const oversizedOutput = JSON.stringify({
      exitCode: 1,
      signal: null,
      stdout: rawMarker.repeat(32_000),
      stderr: "expected failure assertion",
    });
    const shaper = fakeShaper(FAILURE_OBSERVATION);
    const { ctx } = buildContext({
      task: TASK,
      model: { call: () => Promise.resolve(response()) },
      tools: commandTool(oversizedOutput),
      shaperPort: shaper.port,
      limits: { maxContextBytes: 512_000 },
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });

    const step = await handleToolCall(ctx);

    expect(step).toEqual({ to: "model-call", reason: "tool results fed back to model" });
    expect(contextBytes(ctx.messages)).toBeLessThanOrEqual(512_000);
    const last = ctx.messages[ctx.messages.length - 1];
    expect(last?.role).toBe("tool");
    expect(last?.content).toContain("keiko.compactedToolObservation");
    expect(last?.content).toContain("expected failure assertion");
    expect(last?.content).toContain("artifact-long-output");
    expect(last?.content).not.toContain(rawMarker.repeat(100));
  });

  it("oldObservationCompaction: a later tool result can fit after prior raw output is compacted", async () => {
    const firstMarker = "first-raw-observation";
    const secondMarker = "second-raw-observation";
    const firstOutput = firstMarker.repeat(13_000);
    const secondOutput = secondMarker.repeat(13_000);
    const shaper = fakeShaper(FAILURE_OBSERVATION);
    const { ctx } = buildContext({
      task: TASK,
      model: { call: () => Promise.resolve(response()) },
      tools: sequenceCommandTool([firstOutput, secondOutput]),
      shaperPort: shaper.port,
      limits: { maxContextBytes: 512_000 },
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });

    const firstStep = await handleToolCall(ctx);

    expect(firstStep.to).toBe("model-call");
    expect(ctx.messages[ctx.messages.length - 1]?.content).toBe(firstOutput);
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c2", "run_command")],
    });

    const secondStep = await handleToolCall(ctx);

    expect(secondStep.to).toBe("model-call");
    expect(contextBytes(ctx.messages)).toBeLessThanOrEqual(512_000);
    const serialized = JSON.stringify(ctx.messages);
    expect(serialized).toContain("keiko.compactedToolObservation");
    expect(serialized).not.toContain(firstMarker.repeat(100));
    expect(serialized).toContain(secondMarker.repeat(100));
  });

  it("oversizedRawNoShaper: a raw over-budget tool result still fails closed without a shaper", async () => {
    const oversizedOutput = "x".repeat(520_000);
    const { ctx } = buildContext({
      task: TASK,
      model: { call: () => Promise.resolve(response()) },
      tools: commandTool(oversizedOutput),
      limits: { maxContextBytes: 512_000 },
    });
    ctx.lastResponse = response({
      finishReason: "tool_calls",
      toolCalls: [toolCall("c1", "run_command")],
    });

    const step = await handleToolCall(ctx);

    expect(step.to).toBe("limit-exceeded");
    expect(ctx.failure?.category).toBe("HARNESS_LIMIT_CONTEXT_SIZE");
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
