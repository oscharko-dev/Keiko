import { describe, expect, it } from "vitest";

import {
  createGovernedTaskBranches,
  GOVERNED_TASK_BRANCHES_MAX_RUNS,
  type GovernedTaskBranch,
} from "./governedTaskBranches.js";

describe("the task branches Keiko moved runs onto (#3907)", () => {
  const record = (runId: string, branch: string): GovernedTaskBranch => ({
    runId,
    taskBranch: branch,
    baseBranch: "main",
    headSha: "1".repeat(40),
    workspaceDigest: "a".repeat(64),
  });

  it("answers the last branch of each run and forgets one on request", () => {
    const own = createGovernedTaskBranches();
    expect(own.latest("run-a")).toBeUndefined();
    own.record(record("run-a", "feature/one"));
    own.record(record("run-a", "feature/two"));
    expect(own.latest("run-a")?.taskBranch).toBe("feature/two");
    expect(own.latest("run-b")).toBeUndefined();
    own.clear("run-a");
    expect(own.latest("run-a")).toBeUndefined();
  });

  it("holds an immutable record, never the caller's object", () => {
    const own = createGovernedTaskBranches();
    const input = record("run-a", "feature/one");
    own.record(input);
    const held = own.latest("run-a");
    expect(held).not.toBe(input);
    expect(Object.isFrozen(held)).toBe(true);
  });

  it("is bounded: the run rebound longest ago is forgotten first", () => {
    const own = createGovernedTaskBranches();
    own.record(record("run-oldest", "feature/old"));
    for (let index = 0; index < GOVERNED_TASK_BRANCHES_MAX_RUNS; index += 1)
      own.record(record(`run-${String(index)}`, "feature/x"));
    expect(own.latest("run-oldest")).toBeUndefined();
    expect(own.latest(`run-${String(GOVERNED_TASK_BRANCHES_MAX_RUNS - 1)}`)).toBeDefined();
  });
});
