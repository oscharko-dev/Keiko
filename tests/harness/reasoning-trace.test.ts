import { describe, expect, it } from "vitest";
import { Emitter } from "../../src/harness/emitter.js";
import { runLoop } from "../../src/harness/loop.js";
import type { EventSink } from "../../src/harness/ports.js";
import { MemoryEventSink } from "../../src/harness/sinks.js";
import type { HarnessEvent, TaskInput } from "../../src/harness/types.js";
import { buildContext, response, scriptedModel, stubClock } from "./_support.js";

const EXPLAIN: TaskInput = { taskType: "explain-plan", input: { filePath: "src/foo.ts" } };

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
      rationale: "leaking Bearer sk-abcdefghijklmnopqrstuvwxyz now",
    });
    const trace = received[0];
    expect(trace?.type).toBe("reasoning:trace");
    if (trace?.type === "reasoning:trace") {
      expect(trace.rationale).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
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
      diff: "token Bearer sk-abcdefghijklmnopqrstuvwxyz",
    });
    const raw = memory.events()[0];
    const redacted = received[0];
    if (raw?.type === "patch:proposed" && redacted?.type === "patch:proposed") {
      expect(raw.diff).toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(redacted.diff).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    }
  });

  it("redacts a secret in run:completed report before emitting to a non-retaining sink", () => {
    const received: HarnessEvent[] = [];
    const nonMemorySink: EventSink = { emit: (e) => received.push(e) };
    const memory = new MemoryEventSink();
    const emitter = new Emitter([memory, nonMemorySink], stubClock().clock, "run-1", "fp");
    emitter.emit({
      type: "run:completed",
      report: "found Bearer sk-abcdefghijklmnopqrstuvwxyz in output",
    });
    const raw = memory.events()[0];
    const redacted = received[0];
    expect(raw?.type).toBe("run:completed");
    expect(redacted?.type).toBe("run:completed");
    if (raw?.type === "run:completed") {
      expect(raw.report).toContain("sk-abcdefghijklmnopqrstuvwxyz");
    }
    if (redacted?.type === "run:completed") {
      expect(redacted.report).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
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
      patchDiff: "diff with Bearer sk-abcdefghijklmnopqrstuvwxyz inside",
    });
    const raw = memory.events()[0];
    const redacted = received[0];
    if (raw?.type === "run:completed" && redacted?.type === "run:completed") {
      expect(raw.patchDiff).toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(redacted.patchDiff).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
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
});
