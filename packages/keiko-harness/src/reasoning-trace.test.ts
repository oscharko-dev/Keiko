import { describe, expect, it } from "vitest";
import { Emitter } from "./emitter.js";
import { runLoop } from "./loop.js";
import type { EventSink } from "./ports.js";
import { MemoryEventSink } from "./sinks.js";
import type { HarnessEvent, TaskInput } from "./types.js";
import { buildContext, response, scriptedModel, stubClock } from "./_support.js";

const EXPLAIN: TaskInput = { taskType: "explain-plan", input: { filePath: "src/foo.ts" } };
const TOKEN_VALUE = "fixture-token-value";
const BEARER_FIXTURE = `Bearer ${TOKEN_VALUE}`;

function traces(
  events: readonly HarnessEvent[],
): Extract<HarnessEvent, { type: "reasoning:trace" }>[] {
  return events.filter((e) => e.type === "reasoning:trace");
}

describe("reasoning:trace emission", () => {
  it("emits a reasoning:trace at the planning phase with a non-empty rationale", async () => {
    const { port } = scriptedModel([response()]);
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port });
    await runLoop(ctx);
    const planning = traces(sink.events()).find((e) => e.phase === "planning");
    expect(planning?.rationale.length ?? 0).toBeGreaterThan(0);
  });

  it("emits a reasoning:trace at the model-call phase carrying the model response", async () => {
    const { port } = scriptedModel([response({ content: "the model said this" })]);
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port });
    await runLoop(ctx);
    const modelTrace = traces(sink.events()).find((e) => e.phase === "model-call");
    expect(modelTrace?.modelResponse).toBe("the model said this");
  });
});

describe("redaction at non-memory sinks (ADR-0004 D6)", () => {
  it("redacts a secret in the rationale before emitting to a non-retaining sink", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const emitter = new Emitter([nonMemorySink], stubClock().clock, "run-1", "fp");
    emitter.emit({
      type: "reasoning:trace",
      phase: "planning",
      rationale: `leaking ${BEARER_FIXTURE} now`,
    });
    const trace = received[0];
    expect(trace?.type).toBe("reasoning:trace");
    if (trace?.type === "reasoning:trace") {
      expect(trace.rationale).not.toContain(TOKEN_VALUE);
      expect(trace.rationale).toContain("[REDACTED]");
    }
  });

  it("retains the secret verbatim for a sink that declares retainsRawContent", () => {
    const memory = new MemoryEventSink();
    const emitter = new Emitter([memory], stubClock().clock, "run-1", "fp");
    emitter.emit({
      type: "patch:proposed",
      targetFile: "src/foo.ts",
      patchBytes: 5,
      diff: "secret-source-code",
    });
    const event = memory.events()[0];
    expect(event?.type).toBe("patch:proposed");
    if (event?.type === "patch:proposed") {
      expect(event.diff).toBe("secret-source-code");
    }
  });

  it("redacts the diff for a non-retaining sink while the memory sink keeps it raw", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const memory = new MemoryEventSink();
    const emitter = new Emitter([memory, nonMemorySink], stubClock().clock, "run-1", "fp");
    emitter.emit({
      type: "patch:proposed",
      targetFile: "src/foo.ts",
      patchBytes: 30,
      diff: `token ${BEARER_FIXTURE}`,
    });
    const raw = memory.events()[0];
    const redacted = received[0];
    if (raw?.type === "patch:proposed" && redacted?.type === "patch:proposed") {
      expect(raw.diff).toContain(TOKEN_VALUE);
      expect(redacted.diff).not.toContain(TOKEN_VALUE);
    }
  });

  it("redacts a secret in run:completed report before emitting to a non-retaining sink", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const memory = new MemoryEventSink();
    const emitter = new Emitter([memory, nonMemorySink], stubClock().clock, "run-1", "fp");
    emitter.emit({
      type: "run:completed",
      report: `found ${BEARER_FIXTURE} in output`,
    });
    const raw = memory.events()[0];
    const redacted = received[0];
    expect(raw?.type).toBe("run:completed");
    expect(redacted?.type).toBe("run:completed");
    if (raw?.type === "run:completed") {
      expect(raw.report).toContain(TOKEN_VALUE);
    }
    if (redacted?.type === "run:completed") {
      expect(redacted.report).not.toContain(TOKEN_VALUE);
      expect(redacted.report).toContain("[REDACTED]");
    }
  });

  it("redacts a secret in run:completed patchDiff before emitting to a non-retaining sink", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const memory = new MemoryEventSink();
    const emitter = new Emitter([memory, nonMemorySink], stubClock().clock, "run-1", "fp");
    emitter.emit({
      type: "run:completed",
      report: "clean",
      patchDiff: `diff with ${BEARER_FIXTURE} inside`,
    });
    const raw = memory.events()[0];
    const redacted = received[0];
    if (raw?.type === "run:completed" && redacted?.type === "run:completed") {
      expect(raw.patchDiff).toContain(TOKEN_VALUE);
      expect(redacted.patchDiff).not.toContain(TOKEN_VALUE);
      expect(redacted.patchDiff).toContain("[REDACTED]");
    }
  });

  it("does not spread patchDiff on run:completed when it is absent", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const emitter = new Emitter([nonMemorySink], stubClock().clock, "run-1", "fp");
    emitter.emit({ type: "run:completed", report: "ok" });
    const event = received[0];
    expect(event?.type).toBe("run:completed");
    if (event?.type === "run:completed") {
      expect("patchDiff" in event).toBe(false);
    }
  });

  it("redacts failure, cancellation, and verification details before non-retaining sinks", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const emitter = new Emitter([nonMemorySink], stubClock().clock, "run-1", "fp");
    const secret = BEARER_FIXTURE;
    emitter.emit({
      type: "model:call:failed",
      modelId: "m",
      errorCode: "UNKNOWN",
      message: `model ${secret}`,
    });
    emitter.emit({
      type: "tool:call:failed",
      toolName: "read_file",
      toolCallId: "t1",
      errorCode: "TOOL_ERROR",
      message: `tool ${secret}`,
    });
    emitter.emit({
      type: "verification:result",
      passed: false,
      detail: `verification ${secret}`,
    });
    emitter.emit({
      type: "run:cancelled",
      atState: "tool-call",
      reason: `cancel ${secret}`,
    });
    emitter.emit({
      type: "run:failed",
      atState: "model-call",
      failure: {
        category: "HARNESS_MODEL_ERROR",
        message: `failure ${secret}`,
        detail: `detail ${secret}`,
      },
    });
    expect(JSON.stringify(received)).not.toContain(TOKEN_VALUE);
    expect(JSON.stringify(received)).toContain("[REDACTED]");
  });
});
