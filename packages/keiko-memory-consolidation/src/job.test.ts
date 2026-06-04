import { describe, expect, it } from "vitest";

import { FIXED_NOW_MS } from "./_support.js";
import { buildConsolidationJob, ConsolidationJobError, transitionJob } from "./job.js";
import type { ConsolidationJob, ConsolidationJobState, ConsolidationResult } from "./types.js";

function emptyCompletedResult(): ConsolidationResult {
  return {
    state: "completed",
    edgesProposed: [],
    updatesProposed: [],
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    elapsedMs: 0,
  };
}

describe("buildConsolidationJob", () => {
  it("returns a job in state 'queued' with the supplied id and startedAt", () => {
    const job = buildConsolidationJob("job-1", FIXED_NOW_MS);
    expect(job).toEqual({ id: "job-1", state: "queued", startedAt: FIXED_NOW_MS });
  });
});

describe("transitionJob - legal transitions", () => {
  it.each<[ConsolidationJobState, ConsolidationJobState]>([
    ["queued", "running"],
    ["queued", "canceled"],
    ["queued", "skipped"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "canceled"],
  ])("allows %s -> %s", (from, to) => {
    const job: ConsolidationJob = { id: "j", state: from };
    const next = transitionJob(job, to);
    expect(next.state).toBe(to);
  });

  it("merges the optional patch (result, completedAt, error)", () => {
    const job: ConsolidationJob = { id: "j", state: "running", startedAt: FIXED_NOW_MS };
    const next = transitionJob(job, "completed", {
      result: emptyCompletedResult(),
      completedAt: FIXED_NOW_MS + 100,
    });
    expect(next).toMatchObject({
      id: "j",
      state: "completed",
      startedAt: FIXED_NOW_MS,
      completedAt: FIXED_NOW_MS + 100,
    });
    expect(next.result?.state).toBe("completed");
  });

  it("does not mutate the input job", () => {
    const job: ConsolidationJob = Object.freeze({ id: "j", state: "queued" });
    expect(() => transitionJob(job, "running")).not.toThrow();
    expect(job.state).toBe("queued");
  });
});

describe("transitionJob - illegal transitions throw ConsolidationJobError", () => {
  it.each<[ConsolidationJobState, ConsolidationJobState]>([
    ["queued", "completed"],
    ["queued", "failed"],
    ["running", "queued"],
    ["running", "running"],
    ["completed", "running"],
    ["completed", "completed"],
    ["failed", "completed"],
    ["canceled", "running"],
    ["skipped", "running"],
  ])("rejects %s -> %s", (from, to) => {
    const job: ConsolidationJob = { id: "j", state: from };
    expect(() => transitionJob(job, to)).toThrow(ConsolidationJobError);
  });

  it("carries the from/to pair in the thrown error for diagnostics", () => {
    const job: ConsolidationJob = { id: "j", state: "completed" };
    try {
      transitionJob(job, "running");
      expect.fail("expected ConsolidationJobError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsolidationJobError);
      const error = err as ConsolidationJobError;
      expect(error.from).toBe("completed");
      expect(error.to).toBe("running");
      expect(error.code).toBe("invalid-transition");
    }
  });
});
