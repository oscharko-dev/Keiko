import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/harness/loop.js";
import type { HarnessEvent, TaskInput } from "../../src/harness/types.js";
import { buildContext, response, scriptedModel, stubClock, toolCall } from "./_support.js";

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
    const { TransportError } = await import("../../src/gateway/errors.js");
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

  it("non-retryable model error -> failed with HARNESS_MODEL_ERROR", async () => {
    const { AuthenticationError } = await import("../../src/gateway/errors.js");
    const { port } = scriptedModel([new AuthenticationError("nope")]);
    const { ctx, sink } = buildContext({ task: EXPLAIN, model: port });
    const outcome = await runLoop(ctx);
    expect(outcome).toBe("failed");
    expect(failureCategory(sink.events())).toBe("HARNESS_MODEL_ERROR");
  });
});
