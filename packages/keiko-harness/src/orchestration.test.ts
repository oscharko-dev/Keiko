import { describe, expect, it } from "vitest";
import { response, scriptedModel, stubClock } from "./_support.js";
import {
  createOrchestrationSession,
  DEFAULT_ROLE_POLICIES,
  type ResourceClaim,
} from "./orchestration.js";
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
    expect(result.childSettlements).toHaveLength(2);
    expect(result.settlement.outcome).toBe("accepted");
    expect(result.settlement.acceptedChildIds).toEqual(["b"]);
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
    expect(result.settlement.outcome).toBe("accepted");
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
    expect(result.settlement.outcome).toBe("no-safe-result");
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
    expect(result.settlement.discardedChildIds).toContain("bad");
  });

  it("serializes same-file write claims before dispatching a second writer", async () => {
    const sequence: string[] = [];
    const hooks = {
      beforeDispatch: (next: OrchestrationChildRequest) => {
        sequence.push(`start:${next.plan.childId}`);
      },
      afterCompletion: (_next: OrchestrationChildRequest, result: { childId: string }) => {
        sequence.push(`done:${result.childId}`);
      },
    };
    const one = child("one", { taskType: "generate-unit-tests", input: { filePath: "src/a.test.ts" } });
    const two = child("two", { taskType: "generate-unit-tests", input: { filePath: "src/a.test.ts" } });
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "parallel",
        children: [one.plan, two.plan],
      },
      [one, two],
      CONFIG,
      makeDeps(
        scriptedModel([
          response({ content: "--- a/a\n+++ b/a\n+one" }),
          response({ content: "--- a/a\n+++ b/a\n+two" }),
        ]).port,
        hooks,
      ),
    );
    const result = await session.result;
    expect(result.state).toBe("completed");
    expect(sequence).toEqual(["start:one", "done:one", "start:two", "done:two"]);
    expect(result.settlement.outcome).toBe("merged");
    expect(result.settlement.mergedChildIds).toEqual(["one", "two"]);
  });

  it("accepts a merger child as the authoritative settlement approver", async () => {
    const implementer = child(
      "draft",
      { taskType: "generate-unit-tests", input: { filePath: "src/a.test.ts" } },
      "implementer",
    );
    const merger = child(
      "merge-review",
      { taskType: "investigate-bug", input: { description: "approve final merge" } },
      "merger",
      ["draft"],
    );
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "sequential",
        children: [implementer.plan, merger.plan],
      },
      [implementer, merger],
      CONFIG,
      makeDeps(
        scriptedModel([
          response({ content: "--- a/a\n+++ b/a\n+draft" }),
          response({ content: "approved merge plan" }),
        ]).port,
      ),
    );
    const result = await session.result;
    expect(result.state).toBe("completed");
    expect(result.settlement.outcome).toBe("accepted");
    expect(result.settlement.strategy).toBe("escalate-to-reviewer");
    expect(result.settlement.acceptedChildIds).toEqual(["merge-review"]);
    expect(result.settlement.reason.code).toBe("reviewer-required");
  });

  it("blocks exclusive tool contention while allowing unaffected work to continue", async () => {
    const exclusive: ResourceClaim = {
      kind: "tool",
      resourceId: "browser-session",
      access: "exclusive",
      policy: "block",
    };
    const first = child("first", { taskType: "explain-plan", input: { filePath: "first.ts" } }, "reviewer");
    const blocked = {
      ...child("blocked", { taskType: "explain-plan", input: { filePath: "blocked.ts" } }, "reviewer"),
      resourceClaims: [exclusive],
    };
    const activeWithTool = {
      ...child("active", { taskType: "explain-plan", input: { filePath: "active.ts" } }, "reviewer"),
      resourceClaims: [exclusive],
    };
    const session = createOrchestrationSession(
      {
        schemaVersion: "1",
        parent: { runId: "parent-1", kind: "parent-run" },
        executionMode: "parallel",
        children: [activeWithTool.plan, blocked.plan, first.plan],
      },
      [activeWithTool, blocked, first],
      CONFIG,
      makeDeps(
        scriptedModel([
          response({ content: "active-done" }),
          response({ content: "first-done" }),
        ]).port,
      ),
    );
    const result = await session.result;
    expect(result.state).toBe("blocked");
    expect(result.children.active?.state).toBe("completed");
    expect(result.children.first?.state).toBe("completed");
    expect(result.children.blocked?.state).toBe("blocked");
    expect(result.children.blocked?.conflicts?.[0]?.claim.resourceId).toBe("browser-session");
    expect(result.settlement.outcome).toBe("escalated");
    expect(result.settlement.escalatedChildIds).toContain("blocked");
  });
});
