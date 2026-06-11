import { describe, expect, it } from "vitest";
import { response, scriptedModel, stubClock } from "./_support.js";
import { createOrchestrationSession, DEFAULT_ROLE_POLICIES } from "./orchestration.js";
import { counterIdSource } from "./fingerprint.js";
import { MemoryEventSink } from "./sinks.js";
import type { HarnessDeps } from "./session.js";
import type { OrchestrationChildRequest, OrchestrationDeps } from "./orchestration.js";
import type { TaskInput } from "./types.js";
import type { ModelPort } from "./ports.js";

const CONFIG = { model: "m", workingDirectory: "/repo" } as const;

function makeDeps(model: ModelPort, hooks?: OrchestrationDeps["hooks"]): HarnessDeps & OrchestrationDeps {
  return {
    model,
    tools: {
      execute: async (request) => ({ toolCallId: request.toolCallId, output: "tool", durationMs: 0 }),
      listTools: () => [],
    },
    sink: new MemoryEventSink(),
    clock: stubClock().clock,
    idSource: counterIdSource(),
    hooks,
  };
}

function child(
  childId: string,
  task: TaskInput,
  role: OrchestrationChildRequest["plan"]["role"] = "implementer",
  dependsOn: readonly string[] = [],
): OrchestrationChildRequest {
  return {
    plan: {
      childId,
      title: childId,
      role,
      taskType: task.taskType,
      authority: DEFAULT_ROLE_POLICIES[role].defaultAuthority,
      dependsOn,
    },
    task,
  };
}

describe("createOrchestrationSession", () => {
  it("runs dependent children in order", async () => {
    const sequence: string[] = [];
    const hooks = {
      beforeDispatch: (next: OrchestrationChildRequest) => {
        sequence.push(`start:${next.plan.childId}`);
      },
      afterCompletion: (_next: OrchestrationChildRequest, result: { childId: string }) => {
        sequence.push(`done:${result.childId}`);
      },
    };
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "sequential",
        children: [child("a", { taskType: "explain-plan", input: { filePath: "a.ts" } }, "planner").plan, child("b", { taskType: "verify", input: { workspaceRoot: "/repo" } }, "validator", ["a"]).plan],
      },
      [
        child("a", { taskType: "explain-plan", input: { filePath: "a.ts" } }, "planner"),
        child("b", { taskType: "verify", input: { workspaceRoot: "/repo" } }, "validator", ["a"]),
      ],
      CONFIG,
      makeDeps(scriptedModel([response({ content: "a" }), response({ content: "b" })]).port, hooks),
    );
    const result = await session.result;
    expect(result.state).toBe("completed");
    expect(sequence).toEqual(["start:a", "done:a", "start:b", "done:b"]);
    expect(result.children.a?.state).toBe("completed");
    expect(result.children.b?.state).toBe("completed");
  });

  it("dispatches independent parallel-eligible children together in parallel mode", async () => {
    const activeSnapshots: string[][] = [];
    const hooks = {
      beforeDispatch: (_next: OrchestrationChildRequest, active: readonly string[]) => {
        activeSnapshots.push([...active]);
      },
    };
    const first = child("one", { taskType: "explain-plan", input: { filePath: "one.ts" } }, "reviewer");
    const second = child("two", { taskType: "explain-plan", input: { filePath: "two.ts" } }, "reviewer");
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "parallel",
        children: [first.plan, second.plan],
      },
      [first, second],
      CONFIG,
      makeDeps(scriptedModel([response({ content: "one-done" }), response({ content: "two-done" })]).port, hooks),
    );
    const result = await session.result;
    expect(result.state).toBe("completed");
    expect(activeSnapshots).toEqual([[], ["one"]]);
  });

  it("propagates cancellation to active children", async () => {
    const model: ModelPort = {
      call: (_request, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    };
    const request = child("a", { taskType: "investigate-bug", input: { description: "a" } });
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "single",
        children: [request.plan],
      },
      [request],
      CONFIG,
      makeDeps(model),
    );
    await Promise.resolve();
    await Promise.resolve();
    session.cancel("stop");
    const result = await session.result;
    expect(result.state).toBe("cancelled");
    expect(result.transitions.some((step) => step.to === "cancelling")).toBe(true);
    expect(result.children.a?.state).toBe("cancelled");
  });

  it("fails when a child violates its role policy", async () => {
    const invalid = child(
      "bad",
      { taskType: "investigate-bug", input: { description: "bad" } },
      "reviewer",
    );
    const invalidRequest: OrchestrationChildRequest = {
      ...invalid,
      plan: {
        ...invalid.plan,
        authority: DEFAULT_ROLE_POLICIES.implementer.defaultAuthority,
      },
    };
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "parallel",
        children: [invalidRequest.plan],
      },
      [invalidRequest],
      CONFIG,
      makeDeps(scriptedModel([response({ content: "unused" })]).port),
    );
    const result = await session.result;
    expect(result.state).toBe("failed");
    expect(result.children.bad?.reason).toContain("violates role policy");
  });
});
